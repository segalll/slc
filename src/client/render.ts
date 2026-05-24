import { gameStatePacket, gameTailPacket, uint16ToCoord } from "../shared/model";
import type { GameSettings, PlayerInfo, Segment } from "../shared/model";

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
}

const floatsPerSegment = 12;
const verticesPerSegment = 6;
const initialSegmentCapacity = 64;

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
    private mvpUbo: WebGLBuffer;
    private colorUniform: WebGLUniformLocation;

    private players: Map<string, Player>;
    private indexToId: Map<number, string>;

    private aspectRatio: number;
    private lineWidth: number = 0.002;

    private renderLoopStarted: boolean = false;
    private inCountdown: boolean = false;
    private countdownTimeout: ReturnType<typeof setTimeout> | null = null;

    private indicatorVao: WebGLVertexArrayObject;
    private indicatorVbo: WebGLBuffer;

    private namesElement: HTMLElement;

    constructor(aspectRatio: number) {
        const canvas = document.getElementById('game') as HTMLCanvasElement;
        const gl = canvas.getContext('webgl2') as WebGL2RenderingContext;

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
            out vec4 color;
            void main() {
                color = vec4(uColor, 1);
            }`
        );
        gl.compileShader(playerFragmentShader);
        this.playerProgram = gl.createProgram() as WebGLProgram;
        gl.attachShader(this.playerProgram, playerVertexShader);
        gl.attachShader(this.playerProgram, playerFragmentShader);
        gl.linkProgram(this.playerProgram);

        const mvpBlockIndex = gl.getUniformBlockIndex(this.playerProgram, "MVP");
        const mvpBlockSize = gl.getActiveUniformBlockParameter(this.playerProgram, mvpBlockIndex, gl.UNIFORM_BLOCK_DATA_SIZE);
        this.mvpUbo = gl.createBuffer()!;
        gl.bindBuffer(gl.UNIFORM_BUFFER, this.mvpUbo);
        gl.bufferData(gl.UNIFORM_BUFFER, mvpBlockSize, gl.DYNAMIC_DRAW);
        gl.bindBuffer(gl.UNIFORM_BUFFER, null);
        gl.bindBufferBase(gl.UNIFORM_BUFFER, 0, this.mvpUbo);
        gl.uniformBlockBinding(this.playerProgram, mvpBlockIndex, 0);

        this.colorUniform = gl.getUniformLocation(this.playerProgram, "uColor")!;

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

        this.gl = gl;
        this.players = new Map<string, Player>();
        this.indexToId = new Map<number, string>();

        this.aspectRatio = aspectRatio;

        this.namesElement = document.getElementById("names")!;

        this.resize();
    }

    private updateAspectRatio(aspectRatio: number) {
        this.aspectRatio = aspectRatio;

        const projection = ortho(-aspectRatio, aspectRatio, -1, 1, -1, 1);
        this.gl.bindBuffer(this.gl.UNIFORM_BUFFER, this.mvpUbo);
        this.gl.bufferSubData(this.gl.UNIFORM_BUFFER, 0, new Float32Array(projection));
        this.gl.bindBuffer(this.gl.UNIFORM_BUFFER, null);

        this.resize();
    }

    updateGameSettings(gameSettings: GameSettings) {
        this.updateAspectRatio(gameSettings.aspectRatio);
        if (this.lineWidth !== gameSettings.lineWidth) {
            this.lineWidth = gameSettings.lineWidth;
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
        for (const player of this.players.values()) {
            player.segments = [];
            player.spawnPosition = null;
        }
        if (this.countdownTimeout) {
            clearTimeout(this.countdownTimeout);
        }
        this.countdownTimeout = setTimeout(() => {
            this.inCountdown = false;
        }, 3000);
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
            const vao = this.gl.createVertexArray();
            this.gl.bindVertexArray(vao);
            
            const vbo = this.gl.createBuffer();
            this.gl.bindBuffer(this.gl.ARRAY_BUFFER, vbo);

            this.gl.enableVertexAttribArray(0);
            this.gl.vertexAttribPointer(0, 2, this.gl.FLOAT, false, 0, 0);

            const player: Player = {
                id: playerInfo.id,
                vao: vao!,
                vbo: vbo!,
                name: playerInfo.name,
                color: playerInfo.color,
                score: playerInfo.score,
                segments: [],
                segmentCapacity: 0,
                spawnPosition: null
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

    private segmentToVertices(segment: Segment, output: Float32Array, offset: number) {
        const [[p1x, p1y], [p2x, p2y]] = segment;
        if (p1x === p2x) {
            output.set([
                p1x - this.lineWidth, p1y,
                p1x + this.lineWidth, p1y,
                p2x - this.lineWidth, p2y,
                p2x - this.lineWidth, p2y,
                p1x + this.lineWidth, p1y,
                p2x + this.lineWidth, p2y
            ], offset);
        } else {
            output.set([
                p1x, p1y - this.lineWidth,
                p1x, p1y + this.lineWidth,
                p2x, p2y - this.lineWidth,
                p2x, p2y - this.lineWidth,
                p1x, p1y + this.lineWidth,
                p2x, p2y + this.lineWidth
            ], offset);
        }
    }

    private uploadPlayerSegments(player: Player, startIndex: number = 0) {
        if (player.segments.length === 0) {
            return;
        }

        const grew = this.ensureSegmentCapacity(player, player.segments.length);
        const uploadStartIndex = grew ? 0 : startIndex;
        const uploadSegments = player.segments.slice(uploadStartIndex);
        const data = new Float32Array(floatsPerSegment * uploadSegments.length);

        for (let i = 0; i < uploadSegments.length; i++) {
            this.segmentToVertices(uploadSegments[i], data, floatsPerSegment * i);
        }

        this.gl.bindBuffer(this.gl.ARRAY_BUFFER, player.vbo);
        this.gl.bufferSubData(this.gl.ARRAY_BUFFER, floatsPerSegment * 4 * uploadStartIndex, data);
    }

    updateGameState(buffer: ArrayBuffer) {
        if (buffer.byteLength < gameStatePacket.playerCountBytes) {
            return;
        }

        const view = new DataView(buffer);
        const numPlayers = view.getUint8(gameStatePacket.playerCountOffset);
        const headerSize = gameStatePacket.playerCountBytes + numPlayers * gameStatePacket.playerHeaderBytes;
        if (buffer.byteLength < headerSize) {
            return;
        }

        let offset = gameStatePacket.playerCountBytes;
        let segmentOffset = headerSize;

        for (let p = 0; p < numPlayers; p++) {
            const playerIndex = view.getUint8(offset + gameStatePacket.playerIndexOffset);
            const startIndex = view.getUint32(offset + gameStatePacket.playerStartIndexOffset, true);
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
                player.spawnPosition = [
                    uint16ToCoord(view.getUint16(segmentOffset + gameStatePacket.segmentStartXOffset, true), -this.aspectRatio, this.aspectRatio),
                    uint16ToCoord(view.getUint16(segmentOffset + gameStatePacket.segmentStartYOffset, true), -1.0, 1.0)
                ];
            }

            for (let i = 0; i < numSegments; i++) {
                const p1x = uint16ToCoord(view.getUint16(segmentOffset + gameStatePacket.segmentStartXOffset, true), -this.aspectRatio, this.aspectRatio);
                const p1y = uint16ToCoord(view.getUint16(segmentOffset + gameStatePacket.segmentStartYOffset, true), -1.0, 1.0);
                const p2x = uint16ToCoord(view.getUint16(segmentOffset + gameStatePacket.segmentEndXOffset, true), -this.aspectRatio, this.aspectRatio);
                const p2y = uint16ToCoord(view.getUint16(segmentOffset + gameStatePacket.segmentEndYOffset, true), -1.0, 1.0);
                segmentOffset += gameStatePacket.segmentBytes;
                segments.push([[p1x, p1y], [p2x, p2y]]);
            }

            player.segments.splice(startIndex, player.segments.length - startIndex, ...segments);
            this.uploadPlayerSegments(player, startIndex);
        }
    }

    updateGameTail(buffer: ArrayBuffer) {
        if (buffer.byteLength < gameTailPacket.playerCountBytes) {
            return;
        }

        const view = new DataView(buffer);
        const numPlayers = view.getUint8(gameTailPacket.playerCountOffset);
        const expectedBytes = gameTailPacket.playerCountBytes + numPlayers * gameTailPacket.playerBytes;
        if (buffer.byteLength < expectedBytes) {
            return;
        }

        let offset = gameTailPacket.playerCountBytes;
        for (let p = 0; p < numPlayers; p++) {
            const playerIndex = view.getUint8(offset + gameTailPacket.playerIndexOffset);
            const segmentIndex = view.getUint32(offset + gameTailPacket.playerSegmentIndexOffset, true);
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

            player.segments[segmentIndex][1] = end;
            this.uploadPlayerSegments(player, segmentIndex);
        }
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
        for (const player of this.players.values()) {
            if (player.segments.length === 0) {
                continue;
            }
            this.gl.bindVertexArray(player.vao);
            this.gl.bindBuffer(this.gl.ARRAY_BUFFER, player.vbo);
            this.gl.uniform3fv(this.colorUniform, player.color);
            this.gl.drawArrays(this.gl.TRIANGLES, 0, verticesPerSegment * player.segments.length);
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
            this.gl.uniform3fv(this.colorUniform, player.color);
            this.gl.drawArrays(this.gl.TRIANGLES, offset, 6);
            offset += 6;
        }
    }
}
