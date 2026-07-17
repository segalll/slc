import { Direction, directionToVector, gameStatePacket, gameTailPacket, tickRate, uint16ToCoord, worldStatePacket } from "../shared/model";
import { buildFieldSegments, getPortalCapSegments, segmentToQuad } from "../shared/geometry";
import type { FieldShape, GameSettings, PlayerInfo, Segment } from "../shared/model";
import type { Clock } from "./clock";

interface Player {
    id: string;
    vao: WebGLVertexArrayObject;
    vbo: WebGLBuffer;
    name: string;
    color: [number, number, number];
    score: number;
    segments: Segment[];
    segmentCapacity: number;
    spawnPosition: [number, number] | null;
    tailSamples: { tick: number; end: [number, number] }[]; // recent head samples for the current growing segment (remote players)
    dead: boolean; // once dead, the final segment is authoritative and no longer interpolated
}

type Color = [number, number, number];

const floatsPerSegment = 12;
const floatsPerGlowSegment = 18;
const verticesPerSegment = 6;
const initialSegmentCapacity = 64;

// Remote players are rendered slightly in the past and interpolated between tail samples, so their
// motion is smooth instead of stepping at packet rate. The local player is left on the authoritative
// head (Phase 2b adds prediction). Tunable.
const remoteDelayTicks = 3;   // how far behind the newest server tick remote players are drawn (~50ms)
const playoutSlew = 0.05;     // per-frame pull of the playout clock toward its delay target
const maxTailSamples = 16;    // per-player ring of recent (tick, head) samples for the current segment

const predictLocal = true;    // client-side prediction of the local player; set false to render it authoritatively
const secondsPerTick = 1 / tickRate;

// Axis-aligned unit vector of a movement delta, or null if too small to tell (just spawned/turned).
const axisUnit = (dx: number, dy: number): [number, number] | null => {
    const adx = Math.abs(dx);
    const ady = Math.abs(dy);
    if (adx < 1e-9 && ady < 1e-9) return null;
    return adx >= ady ? [Math.sign(dx), 0] : [0, Math.sign(dy)];
};

// Matches the server's rule: a turn must change axis (no reversing or continuing along the same axis).
const isValidTurn = (dir: [number, number], turn: Direction): boolean => {
    return dir[1] === 0
        ? turn === Direction.Up || turn === Direction.Down
        : turn === Direction.Left || turn === Direction.Right;
};
const neutralColor: Color = [0.65, 0.65, 0.65];
const portalGlowWidthScale = 16;
const portalColors: { core: Color; frontGlow: Color; backGlow: Color }[] = [
    { core: [0.0, 0.75, 1.0], frontGlow: [0.0, 0.75, 1.0], backGlow: [1.0, 0.42, 0.0] },
    { core: [0.35, 1.0, 0.35], frontGlow: [0.35, 1.0, 0.35], backGlow: [1.0, 0.2, 0.85] },
    { core: [0.25, 0.45, 1.0], frontGlow: [0.25, 0.45, 1.0], backGlow: [1.0, 0.82, 0.12] },
    { core: [0.0, 0.95, 0.85], frontGlow: [0.0, 0.95, 0.85], backGlow: [1.0, 0.18, 0.18] }
];

const ortho = (left: number, right: number, bottom: number, top: number, near: number, far: number) => {
    const lr = 1 / (left - right);
    const bt = 1 / (bottom - top);
    const nf = 1 / (near - far);
    return [
        -2 * lr, 0, 0, 0,
        0, -2 * bt, 0, 0,
        0, 0, 2 * nf, 0,
        (left + right) * lr, (top + bottom) * bt, (far + near) * nf, 1
    ];
}

export class Renderer {
    private gl: WebGL2RenderingContext;
    private playerProgram: WebGLProgram;
    private portalGlowProgram: WebGLProgram;
    private mvpUbo: WebGLBuffer;
    private colorUniform: WebGLUniformLocation;
    private alphaUniform: WebGLUniformLocation;
    private portalGlowFrontColorUniform: WebGLUniformLocation;
    private portalGlowBackColorUniform: WebGLUniformLocation;
    private portalGlowTimeUniform: WebGLUniformLocation;
    private fieldVao: WebGLVertexArrayObject;
    private fieldVbo: WebGLBuffer;
    private worldVao: WebGLVertexArrayObject;
    private worldVbo: WebGLBuffer;
    private portalGlowVao: WebGLVertexArrayObject;
    private portalGlowVbo: WebGLBuffer;
    private portalVao: WebGLVertexArrayObject;
    private portalVbo: WebGLBuffer;
    private portalCapVao: WebGLVertexArrayObject;
    private portalCapVbo: WebGLBuffer;

    private players: Map<string, Player>;
    private indexToId: Map<number, string>;
    private fieldShape: FieldShape = "rectangle";
    private fieldSegmentCount: number = 0;
    private worldSegments: Segment[] = [];
    private portalSegments: Segment[] = [];
    private portalPairCount: number = 0;
    private portalCapSegmentCount: number = 0;

    private aspectRatio: number;
    private lineWidth: number = 0.002;
    private segmentScratch: Float32Array = new Float32Array(floatsPerSegment);

    private lastTailTick: number = 0;
    private localIndex: number = -1;   // this client's own player index, or -1 until known
    private playoutTick: number = 0;   // interpolation clock for remote players, in server-tick units
    private lastFrameTime: number = 0;

    private clock: Clock | null = null;
    private moveSpeed: number = 0.3;
    private inputSeq: number = 0;                                              // last assigned local input sequence
    private pendingTurns: { seq: number; dir: Direction; tick: number }[] = []; // predicted turns awaiting server ack
    private localAuthHeadTick: number = 0;                                     // server tick of the local player's authoritative head
    private lastLocalDir: [number, number] | null = null;                      // last known local heading (geometry fallback)
    private localRenderCount: number = 0;                                      // segments to draw for the local player this frame
    private renderLoopStarted: boolean = false;
    private inCountdown: boolean = false;
    private countdownTimeout: ReturnType<typeof setTimeout> | null = null;

    private indicatorVao: WebGLVertexArrayObject;
    private indicatorVbo: WebGLBuffer;

    private namesElement: HTMLElement;

    constructor(aspectRatio: number) {
        const canvas = document.getElementById('game') as HTMLCanvasElement;
        const gl = canvas.getContext('webgl2') as WebGL2RenderingContext;
        this.gl = gl;

        const playerVertexShader = gl.createShader(gl.VERTEX_SHADER) as WebGLShader;
        gl.shaderSource(playerVertexShader,
            `#version 300 es
            #pragma vscode_glsllint_stage: vert
            precision highp float;
            layout(location = 0) in vec2 position;
            uniform MVP {
                mat4 projection;
            };
            void main() {
                gl_Position = projection * vec4(position, 0, 1);
            }`
        );
        gl.compileShader(playerVertexShader);

        const playerFragmentShader = gl.createShader(gl.FRAGMENT_SHADER) as WebGLShader;
        gl.shaderSource(playerFragmentShader,
            `#version 300 es
            #pragma vscode_glsllint_stage: frag
            precision lowp float;
            uniform vec3 uColor;
            uniform float uAlpha;
            out vec4 color;
            void main() {
                color = vec4(uColor, uAlpha);
            }`
        );
        gl.compileShader(playerFragmentShader);
        this.playerProgram = gl.createProgram() as WebGLProgram;
        gl.attachShader(this.playerProgram, playerVertexShader);
        gl.attachShader(this.playerProgram, playerFragmentShader);
        gl.linkProgram(this.playerProgram);

        const portalGlowVertexShader = gl.createShader(gl.VERTEX_SHADER) as WebGLShader;
        gl.shaderSource(portalGlowVertexShader,
            `#version 300 es
            #pragma vscode_glsllint_stage: vert
            precision highp float;
            layout(location = 0) in vec2 position;
            layout(location = 1) in float glowDistance;
            uniform MVP {
                mat4 projection;
            };
            out float vGlowDistance;
            void main() {
                vGlowDistance = glowDistance;
                gl_Position = projection * vec4(position, 0, 1);
            }`
        );
        gl.compileShader(portalGlowVertexShader);

        const portalGlowFragmentShader = gl.createShader(gl.FRAGMENT_SHADER) as WebGLShader;
        gl.shaderSource(portalGlowFragmentShader,
            `#version 300 es
            #pragma vscode_glsllint_stage: frag
            precision lowp float;
            uniform vec3 uFrontColor;
            uniform vec3 uBackColor;
            uniform float uTime;
            in float vGlowDistance;
            out vec4 color;
            void main() {
                float falloff = 1.0 - smoothstep(0.0, 1.0, abs(vGlowDistance));
                float pulse = 0.45 + 0.2 * sin(uTime * 3.0);
                vec3 glowColor = mix(uBackColor, uFrontColor, step(0.0, vGlowDistance));
                color = vec4(glowColor, falloff * falloff * pulse * 0.75);
            }`
        );
        gl.compileShader(portalGlowFragmentShader);
        this.portalGlowProgram = gl.createProgram() as WebGLProgram;
        gl.attachShader(this.portalGlowProgram, portalGlowVertexShader);
        gl.attachShader(this.portalGlowProgram, portalGlowFragmentShader);
        gl.linkProgram(this.portalGlowProgram);

        const mvpBlockIndex = gl.getUniformBlockIndex(this.playerProgram, "MVP");
        const mvpBlockSize = gl.getActiveUniformBlockParameter(this.playerProgram, mvpBlockIndex, gl.UNIFORM_BLOCK_DATA_SIZE);
        const portalGlowMvpBlockIndex = gl.getUniformBlockIndex(this.portalGlowProgram, "MVP");
        this.mvpUbo = gl.createBuffer()!;
        gl.bindBuffer(gl.UNIFORM_BUFFER, this.mvpUbo);
        gl.bufferData(gl.UNIFORM_BUFFER, mvpBlockSize, gl.DYNAMIC_DRAW);
        gl.bindBuffer(gl.UNIFORM_BUFFER, null);
        gl.bindBufferBase(gl.UNIFORM_BUFFER, 0, this.mvpUbo);
        gl.uniformBlockBinding(this.playerProgram, mvpBlockIndex, 0);
        gl.uniformBlockBinding(this.portalGlowProgram, portalGlowMvpBlockIndex, 0);

        this.colorUniform = gl.getUniformLocation(this.playerProgram, "uColor")!;
        this.alphaUniform = gl.getUniformLocation(this.playerProgram, "uAlpha")!;
        this.portalGlowFrontColorUniform = gl.getUniformLocation(this.portalGlowProgram, "uFrontColor")!;
        this.portalGlowBackColorUniform = gl.getUniformLocation(this.portalGlowProgram, "uBackColor")!;
        this.portalGlowTimeUniform = gl.getUniformLocation(this.portalGlowProgram, "uTime")!;

        [this.fieldVao, this.fieldVbo] = this.createSegmentBuffer();
        [this.worldVao, this.worldVbo] = this.createSegmentBuffer();
        [this.portalGlowVao, this.portalGlowVbo] = this.createPortalGlowBuffer();
        [this.portalVao, this.portalVbo] = this.createSegmentBuffer();
        [this.portalCapVao, this.portalCapVbo] = this.createSegmentBuffer();

        this.indicatorVao = gl.createVertexArray()!;
        gl.bindVertexArray(this.indicatorVao);
        this.indicatorVbo = gl.createBuffer()!;
        gl.bindBuffer(gl.ARRAY_BUFFER, this.indicatorVbo);
        gl.bufferData(gl.ARRAY_BUFFER, 1024 * 4, gl.DYNAMIC_DRAW);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

        gl.clearColor(0, 0, 0, 1);

        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

        this.players = new Map<string, Player>();
        this.indexToId = new Map<number, string>();

        this.namesElement = document.getElementById("names")!;

        this.aspectRatio = aspectRatio;
        this.updateAspectRatio(aspectRatio);
        this.updateFieldSegments();
    }

    private updateAspectRatio(aspectRatio: number) {
        this.aspectRatio = aspectRatio;

        const projection = ortho(-aspectRatio, aspectRatio, -1, 1, -1, 1);
        this.gl.bindBuffer(this.gl.UNIFORM_BUFFER, this.mvpUbo);
        this.gl.bufferSubData(this.gl.UNIFORM_BUFFER, 0, new Float32Array(projection));
        this.gl.bindBuffer(this.gl.UNIFORM_BUFFER, null);

        this.resize();
    }

    private createSegmentBuffer(): [WebGLVertexArrayObject, WebGLBuffer] {
        const vao = this.gl.createVertexArray()!;
        this.gl.bindVertexArray(vao);
        const vbo = this.gl.createBuffer()!;
        this.gl.bindBuffer(this.gl.ARRAY_BUFFER, vbo);
        this.gl.enableVertexAttribArray(0);
        this.gl.vertexAttribPointer(0, 2, this.gl.FLOAT, false, 0, 0);
        return [vao, vbo];
    }

    private createPortalGlowBuffer(): [WebGLVertexArrayObject, WebGLBuffer] {
        const vao = this.gl.createVertexArray()!;
        this.gl.bindVertexArray(vao);
        const vbo = this.gl.createBuffer()!;
        this.gl.bindBuffer(this.gl.ARRAY_BUFFER, vbo);
        this.gl.enableVertexAttribArray(0);
        this.gl.vertexAttribPointer(0, 2, this.gl.FLOAT, false, 3 * 4, 0);
        this.gl.enableVertexAttribArray(1);
        this.gl.vertexAttribPointer(1, 1, this.gl.FLOAT, false, 3 * 4, 2 * 4);
        return [vao, vbo];
    }

    private setColor(color: Color, alpha: number = 1) {
        this.gl.uniform3fv(this.colorUniform, color);
        this.gl.uniform1f(this.alphaUniform, alpha);
    }

    private setGlowColors(frontColor: Color, backColor: Color) {
        this.gl.uniform3fv(this.portalGlowFrontColorUniform, frontColor);
        this.gl.uniform3fv(this.portalGlowBackColorUniform, backColor);
    }

    private getPortalColors(pairIndex: number) {
        return portalColors[pairIndex % portalColors.length];
    }

    private setPortalGlowColors(segmentIndex: number) {
        const colors = this.getPortalColors(Math.floor(segmentIndex / 2));
        if (segmentIndex % 2 === 0) {
            this.setGlowColors(colors.frontGlow, colors.backGlow);
        } else {
            this.setGlowColors(colors.backGlow, colors.frontGlow);
        }
    }

    updateGameSettings(gameSettings: GameSettings) {
        this.moveSpeed = gameSettings.moveSpeed;
        const lineWidthChanged = this.lineWidth !== gameSettings.lineWidth;
        const fieldChanged = this.aspectRatio !== gameSettings.aspectRatio || this.fieldShape !== gameSettings.fieldShape;
        this.lineWidth = gameSettings.lineWidth;
        this.fieldShape = gameSettings.fieldShape;
        this.updateAspectRatio(gameSettings.aspectRatio);
        if (fieldChanged || lineWidthChanged) {
            this.updateFieldSegments();
        }
        if (lineWidthChanged) {
            this.uploadWorldSegments();
            this.uploadPortalSegments();
            for (const player of this.players.values()) {
                this.uploadPlayerSegments(player);
            }
        }
    }

    removePlayer(id: string) {
        for (const [index, playerId] of this.indexToId) {
            if (playerId === id) {
                this.indexToId.delete(index);
                break;
            }
        }
        const player = this.players.get(id);
        if (player) {
            this.gl.deleteBuffer(player.vbo);
            this.gl.deleteVertexArray(player.vao);
            this.players.delete(id);
        }
        document.getElementById(id)?.remove();
    }

    private resize() {
        const newWidth = window.innerWidth - 4;
        const newHeight = window.innerHeight - document.getElementById("names")!.clientHeight - 8;

        if (Math.abs((this.gl.canvas.width / this.gl.canvas.height) - this.aspectRatio) < 0.002
            && (this.gl.canvas.width === newWidth || this.gl.canvas.height === newHeight)
            && this.gl.canvas.width <= newWidth && this.gl.canvas.height <= newHeight) {
            return;
        }

        if (newWidth / newHeight > this.aspectRatio) {
            this.gl.canvas.width = newHeight * this.aspectRatio;
            this.gl.canvas.height = newHeight;
        } else {
            this.gl.canvas.width = newWidth;
            this.gl.canvas.height = newWidth / this.aspectRatio;
        }
        this.gl.viewport(0, 0, this.gl.canvas.width, this.gl.canvas.height);
    }

    prepareRound() {
        this.inCountdown = true;
        this.lastTailTick = 0;
        this.playoutTick = 0;
        this.pendingTurns.length = 0;
        this.lastLocalDir = null;
        this.localAuthHeadTick = 0;
        this.localRenderCount = 0;
        for (const player of this.players.values()) {
            player.segments = [];
            player.spawnPosition = null;
            player.tailSamples.length = 0;
            player.dead = false;
        }
        if (this.countdownTimeout) {
            clearTimeout(this.countdownTimeout);
        }
        this.countdownTimeout = setTimeout(() => {
            this.inCountdown = false;
            this.countdownTimeout = null;
        }, 3000);
    }

    setLocalIndex(index: number) {
        this.localIndex = index;
    }

    markDead(id: string) {
        const player = this.players.get(id);
        if (player) {
            player.dead = true;
        }
    }

    private getLocalId(): string | undefined {
        return this.localIndex >= 0 ? this.indexToId.get(this.localIndex) : undefined;
    }

    setClock(clock: Clock) {
        this.clock = clock;
    }

    private getLocalPlayer(): Player | undefined {
        const id = this.getLocalId();
        return id ? this.players.get(id) : undefined;
    }

    // Current predicted heading: the last pending turn, else the authoritative growing-segment direction.
    private predictedDir(local: Player): [number, number] | null {
        if (this.pendingTurns.length > 0) {
            return directionToVector(this.pendingTurns[this.pendingTurns.length - 1].dir);
        }
        const n = local.segments.length;
        if (n === 0) return this.lastLocalDir;
        const q = local.segments[n - 1][0];
        const head = local.segments[n - 1][1];
        return axisUnit(head[0] - q[0], head[1] - q[1]) ?? this.lastLocalDir;
    }

    // Called on every local direction input. Assigns a sequence number, predicts the turn locally if
    // valid, and returns the sequence for the caller to send to the server.
    onLocalTurn(direction: Direction): number {
        const seq = ++this.inputSeq;
        const local = this.getLocalPlayer();
        if (predictLocal && this.clock?.synced && local && !local.dead && !this.inCountdown && local.segments.length > 0) {
            const dir = this.predictedDir(local);
            if (dir && isValidTurn(dir, direction)) {
                this.pendingTurns.push({ seq, dir: direction, tick: this.clock.serverTickNow() });
            }
        }
        return seq;
    }

    modifyPlayer(playerInfo: PlayerInfo) {
        this.indexToId.set(playerInfo.index, playerInfo.id);

        if (this.players.has(playerInfo.id)) {
            const player = this.players.get(playerInfo.id)!;
            player.name = playerInfo.name;
            player.color = playerInfo.color;
            player.score = playerInfo.score;

            const nameElement = document.getElementById(playerInfo.id)!;
            nameElement.innerText = `${playerInfo.name}: ${playerInfo.score}`;
            nameElement.style.color = `rgb(${Math.floor(playerInfo.color[0] * 255)}, ${Math.floor(playerInfo.color[1] * 255)}, ${Math.floor(playerInfo.color[2] * 255)})`;
        } else {
            const [vao, vbo] = this.createSegmentBuffer();

            const player: Player = {
                id: playerInfo.id,
                vao,
                vbo,
                name: playerInfo.name,
                color: playerInfo.color,
                score: playerInfo.score,
                segments: [],
                segmentCapacity: 0,
                spawnPosition: null,
                tailSamples: [],
                dead: false
            };
            this.players.set(playerInfo.id, player);
            this.ensureSegmentCapacity(player, initialSegmentCapacity);

            const nameElement = document.createElement("pre");
            nameElement.id = playerInfo.id;
            nameElement.innerText = `${playerInfo.name}: ${playerInfo.score}`;
            nameElement.style.color = `rgb(${Math.floor(playerInfo.color[0] * 255)}, ${Math.floor(playerInfo.color[1] * 255)}, ${Math.floor(playerInfo.color[2] * 255)})`;
            this.namesElement.appendChild(nameElement);
        }
    }

    private ensureSegmentCapacity(player: Player, segmentCount: number) {
        if (segmentCount <= player.segmentCapacity) {
            return false;
        }

        let segmentCapacity = Math.max(initialSegmentCapacity, player.segmentCapacity);
        while (segmentCapacity < segmentCount) {
            segmentCapacity *= 2;
        }

        player.segmentCapacity = segmentCapacity;
        this.gl.bindBuffer(this.gl.ARRAY_BUFFER, player.vbo);
        this.gl.bufferData(this.gl.ARRAY_BUFFER, segmentCapacity * floatsPerSegment * 4, this.gl.DYNAMIC_DRAW);
        return true;
    }

    private segmentToVertices(segment: Segment, output: Float32Array, offset: number, width: number = this.lineWidth) {
        const quad = segmentToQuad(segment, width);
        if (!quad) {
            output.fill(0, offset, offset + floatsPerSegment);
            return;
        }

        output.set([
            quad[0][0], quad[0][1],
            quad[3][0], quad[3][1],
            quad[1][0], quad[1][1],
            quad[1][0], quad[1][1],
            quad[3][0], quad[3][1],
            quad[2][0], quad[2][1]
        ], offset);
    }

    private segmentsToVertices(segments: Segment[], width: number = this.lineWidth) {
        const data = new Float32Array(floatsPerSegment * segments.length);
        for (let i = 0; i < segments.length; i++) {
            this.segmentToVertices(segments[i], data, floatsPerSegment * i, width);
        }
        return data;
    }

    private portalGlowSegmentsToVertices() {
        const data = new Float32Array(floatsPerGlowSegment * this.portalSegments.length);
        for (let i = 0; i < this.portalSegments.length; i++) {
            this.portalGlowSegmentToVertices(this.portalSegments[i], data, floatsPerGlowSegment * i);
        }
        return data;
    }

    private portalGlowSegmentToVertices(segment: Segment, output: Float32Array, offset: number) {
        const quad = segmentToQuad(segment, this.lineWidth * portalGlowWidthScale);
        if (!quad) {
            output.fill(0, offset, offset + floatsPerGlowSegment);
            return;
        }

        output.set([
            quad[0][0], quad[0][1], 1,
            quad[3][0], quad[3][1], -1,
            quad[1][0], quad[1][1], 1,
            quad[1][0], quad[1][1], 1,
            quad[3][0], quad[3][1], -1,
            quad[2][0], quad[2][1], -1
        ], offset);
    }

    private updateFieldSegments() {
        const fieldSegments = buildFieldSegments(this.aspectRatio, this.fieldShape);
        this.fieldSegmentCount = fieldSegments.length;
        this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.fieldVbo);
        this.gl.bufferData(this.gl.ARRAY_BUFFER, this.segmentsToVertices(fieldSegments), this.gl.STATIC_DRAW);
    }

    private uploadPlayerSegments(player: Player, startIndex: number = 0) {
        if (player.segments.length === 0) {
            return;
        }

        const grew = this.ensureSegmentCapacity(player, player.segments.length);
        const uploadStartIndex = grew ? 0 : startIndex;
        const uploadSegments = player.segments.slice(uploadStartIndex);

        this.gl.bindBuffer(this.gl.ARRAY_BUFFER, player.vbo);
        this.gl.bufferSubData(this.gl.ARRAY_BUFFER, floatsPerSegment * 4 * uploadStartIndex, this.segmentsToVertices(uploadSegments));
    }

    private uploadPlayerSegment(player: Player, segmentIndex: number) {
        this.segmentToVertices(player.segments[segmentIndex], this.segmentScratch, 0);
        this.gl.bindBuffer(this.gl.ARRAY_BUFFER, player.vbo);
        this.gl.bufferSubData(this.gl.ARRAY_BUFFER, floatsPerSegment * 4 * segmentIndex, this.segmentScratch);
    }

    private uploadWorldSegments() {
        this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.worldVbo);
        this.gl.bufferData(this.gl.ARRAY_BUFFER, this.segmentsToVertices(this.worldSegments), this.gl.STATIC_DRAW);
    }

    private uploadPortalSegments() {
        this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.portalGlowVbo);
        this.gl.bufferData(this.gl.ARRAY_BUFFER, this.portalGlowSegmentsToVertices(), this.gl.STATIC_DRAW);

        this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.portalVbo);
        this.gl.bufferData(this.gl.ARRAY_BUFFER, this.segmentsToVertices(this.portalSegments), this.gl.STATIC_DRAW);

        const capSegments = this.buildPortalCapSegments();
        this.portalCapSegmentCount = capSegments.length;
        this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.portalCapVbo);
        this.gl.bufferData(this.gl.ARRAY_BUFFER, this.segmentsToVertices(capSegments), this.gl.STATIC_DRAW);
    }

    private buildPortalCapSegments() {
        const capSegments: Segment[] = [];
        for (const segment of this.portalSegments) {
            capSegments.push(...getPortalCapSegments(segment, this.lineWidth));
        }
        return capSegments;
    }

    private readSegment(view: DataView, offset: number): Segment {
        return [[
            uint16ToCoord(view.getUint16(offset + worldStatePacket.segmentStartXOffset, true), -this.aspectRatio, this.aspectRatio),
            uint16ToCoord(view.getUint16(offset + worldStatePacket.segmentStartYOffset, true), -1.0, 1.0)
        ], [
            uint16ToCoord(view.getUint16(offset + worldStatePacket.segmentEndXOffset, true), -this.aspectRatio, this.aspectRatio),
            uint16ToCoord(view.getUint16(offset + worldStatePacket.segmentEndYOffset, true), -1.0, 1.0)
        ]];
    }

    updateWorldState(buffer: ArrayBuffer) {
        if (buffer.byteLength < worldStatePacket.segmentCountBytes) {
            return;
        }

        const view = new DataView(buffer);
        const numSegments = view.getUint16(worldStatePacket.segmentCountOffset, true);
        const expectedBytes = worldStatePacket.segmentCountBytes + numSegments * worldStatePacket.segmentBytes;
        if (buffer.byteLength < expectedBytes) {
            return;
        }

        const segments: Segment[] = [];
        let offset = worldStatePacket.segmentCountBytes;
        for (let i = 0; i < numSegments; i++) {
            segments.push(this.readSegment(view, offset));
            offset += worldStatePacket.segmentBytes;
        }

        let portalPairCount = 0;
        const portalSegments: Segment[] = [];
        if (offset < buffer.byteLength) {
            portalPairCount = view.getUint8(offset);
            offset += worldStatePacket.portalPairCountBytes;

            const expectedPortalBytes = offset + portalPairCount * worldStatePacket.portalPairBytes;
            if (buffer.byteLength < expectedPortalBytes) {
                return;
            }

            for (let i = 0; i < portalPairCount; i++) {
                portalSegments.push(
                    this.readSegment(view, offset + worldStatePacket.portalSegmentAOffset),
                    this.readSegment(view, offset + worldStatePacket.portalSegmentBOffset)
                );
                offset += worldStatePacket.portalPairBytes;
            }
        }

        this.worldSegments = segments;
        this.portalSegments = portalSegments;
        this.portalPairCount = portalPairCount;
        this.uploadWorldSegments();
        this.uploadPortalSegments();
    }

    updateGameState(buffer: ArrayBuffer) {
        if (buffer.byteLength < gameStatePacket.headerBytes) {
            return;
        }

        const view = new DataView(buffer);
        const ackSeq = view.getUint32(gameStatePacket.ackSeqOffset, true);
        const numPlayers = view.getUint8(gameStatePacket.playerCountOffset);
        const headerSize = gameStatePacket.headerBytes + numPlayers * gameStatePacket.playerHeaderBytes;
        if (buffer.byteLength < headerSize) {
            return;
        }

        // Drop predicted turns the server has now processed; the rest are replayed on top of the authoritative state.
        while (this.pendingTurns.length > 0 && this.pendingTurns[0].seq <= ackSeq) {
            this.pendingTurns.shift();
        }

        let offset = gameStatePacket.headerBytes;
        let segmentOffset = headerSize;

        for (let p = 0; p < numPlayers; p++) {
            const playerIndex = view.getUint16(offset + gameStatePacket.playerIndexOffset, true);
            const startIndex = view.getUint16(offset + gameStatePacket.playerStartIndexOffset, true);
            const numSegments = view.getUint16(offset + gameStatePacket.playerSegmentCountOffset, true);
            offset += gameStatePacket.playerHeaderBytes;

            const segmentBytes = numSegments * gameStatePacket.segmentBytes;
            if (segmentOffset + segmentBytes > buffer.byteLength) {
                return;
            }

            const playerId = this.indexToId.get(playerIndex);
            if (!playerId || !this.players.has(playerId)) {
                segmentOffset += segmentBytes;
                continue;
            }

            const player = this.players.get(playerId)!;
            if (startIndex > player.segments.length) {
                segmentOffset += segmentBytes;
                continue;
            }

            const segments: Segment[] = [];

            if (this.inCountdown && player.spawnPosition === null && numSegments > 0) {
                player.spawnPosition = this.readSegment(view, segmentOffset)[0];
            }

            for (let i = 0; i < numSegments; i++) {
                segments.push(this.readSegment(view, segmentOffset));
                segmentOffset += gameStatePacket.segmentBytes;
            }

            const prevGrowingStart = player.segments.length > 0 ? player.segments[player.segments.length - 1][0] : null;
            player.segments.splice(startIndex, player.segments.length - startIndex, ...segments);
            this.uploadPlayerSegments(player, startIndex);

            // A new growing segment (turn / spawn / portal) invalidates the remote interpolation samples.
            const growingStart = player.segments.length > 0 ? player.segments[player.segments.length - 1][0] : null;
            if (growingStart && (!prevGrowingStart || prevGrowingStart[0] !== growingStart[0] || prevGrowingStart[1] !== growingStart[1])) {
                player.tailSamples.length = 0;
            }
        }
    }

    updateGameTail(data: ArrayBuffer | Uint8Array) {
        const view = data instanceof Uint8Array
            ? new DataView(data.buffer, data.byteOffset, data.byteLength)
            : new DataView(data);
        if (view.byteLength < gameTailPacket.headerBytes) {
            return;
        }

        // Datagrams can arrive out of order; ignore any tail older than the newest already applied.
        const tick = view.getUint32(gameTailPacket.tickOffset, true);
        if (tick < this.lastTailTick) {
            return;
        }
        this.lastTailTick = tick;

        const localId = this.getLocalId();
        const numPlayers = view.getUint8(gameTailPacket.playerCountOffset);
        const expectedBytes = gameTailPacket.headerBytes + numPlayers * gameTailPacket.playerBytes;
        if (view.byteLength < expectedBytes) {
            return;
        }

        let offset = gameTailPacket.headerBytes;
        for (let p = 0; p < numPlayers; p++) {
            const playerIndex = view.getUint16(offset + gameTailPacket.playerIndexOffset, true);
            const segmentIndex = view.getUint16(offset + gameTailPacket.playerSegmentIndexOffset, true);
            const end: [number, number] = [
                uint16ToCoord(view.getUint16(offset + gameTailPacket.playerEndXOffset, true), -this.aspectRatio, this.aspectRatio),
                uint16ToCoord(view.getUint16(offset + gameTailPacket.playerEndYOffset, true), -1.0, 1.0)
            ];
            offset += gameTailPacket.playerBytes;

            const playerId = this.indexToId.get(playerIndex);
            if (!playerId || !this.players.has(playerId)) {
                continue;
            }

            const player = this.players.get(playerId)!;
            if (segmentIndex !== player.segments.length - 1) {
                continue;
            }

            if (playerId === localId) {
                // local player: record the authoritative head + its tick as the prediction anchor
                player.segments[segmentIndex][1] = end;
                this.localAuthHeadTick = tick;
                this.uploadPlayerSegment(player, segmentIndex);
            } else {
                player.tailSamples.push({ tick, end });
                if (player.tailSamples.length > maxTailSamples) {
                    player.tailSamples.shift();
                }
            }
        }
    }

    // Advances the playout clock and interpolates each remote player's growing head to it.
    private updateRemoteHeads() {
        const now = performance.now();
        const dt = this.lastFrameTime > 0 ? now - this.lastFrameTime : 0;
        this.lastFrameTime = now;

        if (this.lastTailTick === 0) {
            return;
        }
        const target = this.lastTailTick - remoteDelayTicks;
        if (this.playoutTick === 0) {
            this.playoutTick = target;
        } else {
            this.playoutTick += dt / (1000 / tickRate);              // advance at real time, in tick units
            this.playoutTick += (target - this.playoutTick) * playoutSlew; // correct drift toward the delay target
        }

        const localId = this.getLocalId();
        for (const player of this.players.values()) {
            if (player.segments.length === 0 || player.id === localId || player.dead) {
                continue;
            }
            this.uploadGrowingHead(player, this.interpolateHead(player));
        }
    }

    private interpolateHead(player: Player): [number, number] {
        const samples = player.tailSamples;
        const start = player.segments[player.segments.length - 1][0];
        if (samples.length === 0 || this.playoutTick < samples[0].tick) {
            return [start[0], start[1]];
        }
        for (let i = 1; i < samples.length; i++) {
            if (this.playoutTick <= samples[i].tick) {
                const a = samples[i - 1];
                const b = samples[i];
                const f = (this.playoutTick - a.tick) / (b.tick - a.tick || 1);
                return [a.end[0] + (b.end[0] - a.end[0]) * f, a.end[1] + (b.end[1] - a.end[1]) * f];
            }
        }
        const last = samples[samples.length - 1].end;
        return [last[0], last[1]];
    }

    private uploadGrowingHead(player: Player, head: [number, number]) {
        const last = player.segments.length - 1;
        this.segmentToVertices([player.segments[last][0], head], this.segmentScratch, 0);
        this.gl.bindBuffer(this.gl.ARRAY_BUFFER, player.vbo);
        this.gl.bufferSubData(this.gl.ARRAY_BUFFER, floatsPerSegment * 4 * last, this.segmentScratch);
    }

    // Rebuilds the local trail from the authoritative committed segments plus predicted (unacked) turns,
    // advancing the head to the current server time. Returns null to fall back to authoritative rendering.
    private reconstructLocalTrail(local: Player): Segment[] | null {
        if (this.localAuthHeadTick === 0) return null; // no authoritative head sample yet this round
        const n = local.segments.length;
        const q = local.segments[n - 1][0];
        const authHead = local.segments[n - 1][1];
        const dir = axisUnit(authHead[0] - q[0], authHead[1] - q[1]) ?? this.lastLocalDir;
        if (!dir) return null;
        this.lastLocalDir = dir;

        const now = this.clock!.serverTickNow();
        const result: Segment[] = local.segments.slice(0, n - 1);
        let start: [number, number] = [q[0], q[1]];
        let pos: [number, number] = [authHead[0], authHead[1]];
        let tick = this.localAuthHeadTick;
        let heading = dir;

        for (const turn of this.pendingTurns) {
            const advance = this.moveSpeed * (turn.tick - tick) * secondsPerTick;
            const corner: [number, number] = [pos[0] + heading[0] * advance, pos[1] + heading[1] * advance];
            result.push([start, corner]);
            start = corner;
            pos = corner;
            tick = turn.tick;
            heading = directionToVector(turn.dir);
        }
        const advance = this.moveSpeed * (now - tick) * secondsPerTick;
        result.push([start, [pos[0] + heading[0] * advance, pos[1] + heading[1] * advance]]);
        return result;
    }

    private updateLocalHead() {
        const local = this.getLocalPlayer();
        if (!local || local.segments.length === 0) {
            this.localRenderCount = 0;
            return;
        }
        const predicted = predictLocal && this.clock?.synced && !local.dead
            ? this.reconstructLocalTrail(local)
            : null;
        const trail = predicted ?? local.segments;
        this.localRenderCount = trail.length;
        this.ensureSegmentCapacity(local, trail.length);
        this.gl.bindBuffer(this.gl.ARRAY_BUFFER, local.vbo);
        this.gl.bufferSubData(this.gl.ARRAY_BUFFER, 0, this.segmentsToVertices(trail));
    }

    renderLoop() {
        if (this.renderLoopStarted) {
            return;
        }
        this.renderLoopStarted = true;
        this.renderFrame();
    }

    private renderFrame() {
        this.resize();
        this.gl.clear(this.gl.COLOR_BUFFER_BIT);

        this.gl.useProgram(this.playerProgram);
        if (this.fieldSegmentCount > 0) {
            this.gl.bindVertexArray(this.fieldVao);
            this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.fieldVbo);
            this.setColor(neutralColor);
            this.gl.drawArrays(this.gl.TRIANGLES, 0, verticesPerSegment * this.fieldSegmentCount);
        }

        if (this.worldSegments.length > 0) {
            this.gl.bindVertexArray(this.worldVao);
            this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.worldVbo);
            this.setColor(neutralColor);
            this.gl.drawArrays(this.gl.TRIANGLES, 0, verticesPerSegment * this.worldSegments.length);
        }

        if (this.portalPairCount > 0) {
            this.gl.useProgram(this.portalGlowProgram);
            this.gl.uniform1f(this.portalGlowTimeUniform, performance.now() / 1000);
            this.gl.blendFunc(this.gl.SRC_ALPHA, this.gl.ONE);
            this.gl.bindVertexArray(this.portalGlowVao);
            this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.portalGlowVbo);
            for (let i = 0; i < this.portalSegments.length; i++) {
                this.setPortalGlowColors(i);
                this.gl.drawArrays(this.gl.TRIANGLES, i * verticesPerSegment, verticesPerSegment);
            }
            this.gl.blendFunc(this.gl.SRC_ALPHA, this.gl.ONE_MINUS_SRC_ALPHA);
            this.gl.useProgram(this.playerProgram);
        }

        if (this.portalPairCount > 0) {
            this.gl.bindVertexArray(this.portalVao);
            this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.portalVbo);
            for (let i = 0; i < this.portalPairCount; i++) {
                this.setColor(this.getPortalColors(i).core);
                this.gl.drawArrays(this.gl.TRIANGLES, i * verticesPerSegment * 2, verticesPerSegment * 2);
            }
        }

        if (this.portalCapSegmentCount > 0) {
            this.gl.bindVertexArray(this.portalCapVao);
            this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.portalCapVbo);
            this.setColor(neutralColor);
            this.gl.drawArrays(this.gl.TRIANGLES, 0, verticesPerSegment * this.portalCapSegmentCount);
        }

        this.updateRemoteHeads();
        this.updateLocalHead();

        const localId = this.getLocalId();
        for (const player of this.players.values()) {
            const count = player.id === localId ? this.localRenderCount : player.segments.length;
            if (count === 0) {
                continue;
            }
            this.gl.bindVertexArray(player.vao);
            this.gl.bindBuffer(this.gl.ARRAY_BUFFER, player.vbo);
            this.setColor(player.color);
            this.gl.drawArrays(this.gl.TRIANGLES, 0, verticesPerSegment * count);
        }

        if (this.inCountdown) {
            this.renderSpawnIndicators();
        }

        requestAnimationFrame(() => this.renderFrame());
    }

    private renderSpawnIndicators() {
        const size = 0.015;
        const vertices: number[] = [];

        for (const player of this.players.values()) {
            if (!player.spawnPosition) continue;
            const [cx, cy] = player.spawnPosition;
            vertices.push(
                cx - size, cy - size,
                cx + size, cy - size,
                cx - size, cy + size,
                cx - size, cy + size,
                cx + size, cy - size,
                cx + size, cy + size
            );
        }

        if (vertices.length === 0) return;

        this.gl.bindVertexArray(this.indicatorVao);
        this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.indicatorVbo);
        this.gl.bufferSubData(this.gl.ARRAY_BUFFER, 0, new Float32Array(vertices));

        let offset = 0;
        for (const player of this.players.values()) {
            if (!player.spawnPosition) continue;
            this.setColor(player.color);
            this.gl.drawArrays(this.gl.TRIANGLES, offset, 6);
            offset += 6;
        }
    }
}
