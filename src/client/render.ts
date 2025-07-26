import { Socket } from "socket.io-client";
import { GameSettings, PlayerInfo, PlayerState, Point, Segment, GAME_CONSTANTS } from "../shared/model";

interface Player {
    vao: WebGLVertexArrayObject;
    vbo: WebGLBuffer;
    name: string;
    color: [number, number, number];
    score: number;
    segmentCount: number;
}

interface VertexData {
    data: Float32Array;
    offset: number;
}

const ortho = (left: number, right: number, bottom: number, top: number, near: number, far: number): number[] => {
    const lr = 1 / (left - right);
    const bt = 1 / (bottom - top);
    const nf = 1 / (near - far);
    return [
        -2 * lr, 0, 0, 0,
        0, -2 * bt, 0, 0,
        0, 0, 2 * nf, 0,
        (left + right) * lr, (top + bottom) * bt, (far + near) * nf, 1
    ];
};

const createPoint = (x: number, y: number): Point => [x, y];

const createVertexData = (segments: Segment[], lineWidth: number): VertexData => {
    const data = new Float32Array(12 * segments.length);
    
    for (let i = 0; i < segments.length; i++) {
        const p1 = segments[i][0];
        const p2 = segments[i][1];
        const offset = 6 * 2 * i;
        
        if (Math.abs(p1[0] - p2[0]) < 0.001) {
            data.set([
                p1[0] - lineWidth, p1[1],
                p1[0] + lineWidth, p1[1],
                p2[0] - lineWidth, p2[1],
                p2[0] - lineWidth, p2[1],
                p1[0] + lineWidth, p1[1],
                p2[0] + lineWidth, p2[1]
            ], offset);
        } else {
            data.set([
                p1[0], p1[1] - lineWidth,
                p1[0], p1[1] + lineWidth,
                p2[0], p2[1] - lineWidth,
                p2[0], p2[1] - lineWidth,
                p1[0], p1[1] + lineWidth,
                p2[0], p2[1] + lineWidth
            ], offset);
        }
    }
    
    return { data, offset: 0 };
};

export class Renderer {
    private readonly socket: Socket;
    private readonly gl: WebGL2RenderingContext;
    private readonly playerProgram: WebGLProgram;
    private readonly mvpUbo: WebGLBuffer;
    private readonly players: Map<string, Player>;
    private readonly namesElement: HTMLElement;

    private aspectRatio: number;
    private lineWidth: number = GAME_CONSTANTS.DEFAULT_LINE_WIDTH;
    private pendingRedraw: boolean = false;

    constructor(socket: Socket, aspectRatio: number) {
        const canvas = document.getElementById('game') as HTMLCanvasElement;
        const gl = canvas.getContext('webgl2', { preserveDrawingBuffer: true }) as WebGL2RenderingContext;

        this.socket = socket;
        this.gl = gl;
        this.players = new Map<string, Player>();
        this.aspectRatio = aspectRatio;
        this.namesElement = document.getElementById("names")!;

        this.playerProgram = this.createShaderProgram();
        this.mvpUbo = this.createUniformBuffer();
        
        this.setupWebGL();
        this.resize();
    }

    private createShaderProgram(): WebGLProgram {
        const vertexShader = this.gl.createShader(this.gl.VERTEX_SHADER)!;
        this.gl.shaderSource(vertexShader,
            `#version 300 es
            precision highp float;
            layout(location = 0) in vec2 position;
            uniform MVP {
                mat4 projection;
            };
            void main() {
                gl_Position = projection * vec4(position, 0, 1);
            }`
        );
        this.gl.compileShader(vertexShader);

        const fragmentShader = this.gl.createShader(this.gl.FRAGMENT_SHADER)!;
        this.gl.shaderSource(fragmentShader,
            `#version 300 es
            precision lowp float;
            uniform vec3 uColor;
            out vec4 color;
            void main() {
                color = vec4(uColor, 1);
            }`
        );
        this.gl.compileShader(fragmentShader);

        const program = this.gl.createProgram()!;
        this.gl.attachShader(program, vertexShader);
        this.gl.attachShader(program, fragmentShader);
        this.gl.linkProgram(program);

        return program;
    }

    private createUniformBuffer(): WebGLBuffer {
        const mvpBlockIndex = this.gl.getUniformBlockIndex(this.playerProgram, "MVP");
        const mvpBlockSize = this.gl.getActiveUniformBlockParameter(this.playerProgram, mvpBlockIndex, this.gl.UNIFORM_BLOCK_DATA_SIZE);
        const mvpUbo = this.gl.createBuffer()!;
        
        this.gl.bindBuffer(this.gl.UNIFORM_BUFFER, mvpUbo);
        this.gl.bufferData(this.gl.UNIFORM_BUFFER, mvpBlockSize, this.gl.DYNAMIC_DRAW);
        this.gl.bindBuffer(this.gl.UNIFORM_BUFFER, null);
        this.gl.bindBufferBase(this.gl.UNIFORM_BUFFER, 0, mvpUbo);
        this.gl.uniformBlockBinding(this.playerProgram, mvpBlockIndex, 0);

        return mvpUbo;
    }

    private setupWebGL(): void {
        this.gl.clearColor(0, 0, 0, 1);
        this.gl.enable(this.gl.BLEND);
        this.gl.blendFunc(this.gl.SRC_ALPHA, this.gl.ONE_MINUS_SRC_ALPHA);
    }

    private updateProjection(): void {
        const projection = ortho(-this.aspectRatio, this.aspectRatio, -1, 1, -1, 1);
        this.gl.bindBuffer(this.gl.UNIFORM_BUFFER, this.mvpUbo);
        this.gl.bufferSubData(this.gl.UNIFORM_BUFFER, 0, new Float32Array(projection));
        this.gl.bindBuffer(this.gl.UNIFORM_BUFFER, null);
    }

    private createPlayerVAO(): { vao: WebGLVertexArrayObject; vbo: WebGLBuffer } {
        const vao = this.gl.createVertexArray()!;
        this.gl.bindVertexArray(vao);
        
        const vbo = this.gl.createBuffer()!;
        this.gl.bindBuffer(this.gl.ARRAY_BUFFER, vbo);
        this.gl.bufferData(this.gl.ARRAY_BUFFER, 1024 * 512, this.gl.DYNAMIC_DRAW);

        this.gl.enableVertexAttribArray(0);
        this.gl.vertexAttribPointer(0, 2, this.gl.FLOAT, false, 0, 0);

        return { vao, vbo };
    }

    private createPlayerNameElement(playerInfo: PlayerInfo): HTMLElement {
        const nameElement = document.createElement("pre");
        nameElement.id = playerInfo.id;
        nameElement.innerText = `${playerInfo.name}: ${playerInfo.score}`;
        nameElement.style.color = `rgb(${Math.floor(playerInfo.color[0] * 255)}, ${Math.floor(playerInfo.color[1] * 255)}, ${Math.floor(playerInfo.color[2] * 255)})`;
        return nameElement;
    }

    updateGameSettings(gameSettings: GameSettings): void {
        this.aspectRatio = gameSettings.aspectRatio;
        this.lineWidth = gameSettings.lineWidth;
        this.updateProjection();
        this.resize();
    }

    removePlayer(id: string): void {
        this.players.delete(id);
        const nameElement = document.getElementById(id);
        if (nameElement) {
            this.namesElement.removeChild(nameElement);
        }
        this.pendingRedraw = true;
    }

    resize(): void {
        const newWidth = window.innerWidth - 4;
        const newHeight = window.innerHeight - this.namesElement.clientHeight - 8;

        const currentAspectRatio = this.gl.canvas.width / this.gl.canvas.height;
        const aspectRatioDiff = Math.abs(currentAspectRatio - this.aspectRatio);
        const sizeChanged = this.gl.canvas.width !== newWidth || this.gl.canvas.height !== newHeight;
        const fitsInWindow = this.gl.canvas.width <= newWidth && this.gl.canvas.height <= newHeight;

        if (aspectRatioDiff < 0.002 && !sizeChanged && fitsInWindow) {
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

        setTimeout(() => {
            this.socket.emit("redraw");
        }, GAME_CONSTANTS.CANVAS_RESIZE_DELAY);
    }

    prepareRound(): void {
        this.pendingRedraw = true;
    }

    modifyPlayer(playerInfo: PlayerInfo): void {
        if (this.players.has(playerInfo.id)) {
            const player = this.players.get(playerInfo.id)!;
            player.name = playerInfo.name;
            player.color = playerInfo.color;
            player.score = playerInfo.score;

            const nameElement = document.getElementById(playerInfo.id)!;
            nameElement.innerText = `${playerInfo.name}: ${playerInfo.score}`;
            nameElement.style.color = `rgb(${Math.floor(playerInfo.color[0] * 255)}, ${Math.floor(playerInfo.color[1] * 255)}, ${Math.floor(playerInfo.color[2] * 255)})`;
        } else {
            const { vao, vbo } = this.createPlayerVAO();
            
            this.players.set(playerInfo.id, {
                vao,
                vbo,
                name: playerInfo.name,
                color: playerInfo.color,
                score: playerInfo.score,
                segmentCount: 0
            });

            const nameElement = this.createPlayerNameElement(playerInfo);
            this.namesElement.appendChild(nameElement);
        }
    }

    updatePlayer(playerState: PlayerState): void {
        const player = this.players.get(playerState.id);
        if (!player) return;

        this.gl.bindVertexArray(player.vao);
        this.gl.bindBuffer(this.gl.ARRAY_BUFFER, player.vbo);
        
        const vertexData = createVertexData(playerState.missingSegments, this.lineWidth);
        this.gl.bufferSubData(this.gl.ARRAY_BUFFER, 12 * 4 * player.segmentCount, vertexData.data);

        player.segmentCount += playerState.missingSegments.length;
    }
    
    renderLoop(): void {
        this.resize();

        if (this.pendingRedraw) {
            this.pendingRedraw = false;
            this.gl.clear(this.gl.COLOR_BUFFER_BIT);
            this.socket.emit("redraw");
        }

        this.gl.useProgram(this.playerProgram);
        
        for (const player of this.players.values()) {
            if (player.segmentCount === 0) continue;
            
            this.gl.bindVertexArray(player.vao);
            this.gl.bindBuffer(this.gl.ARRAY_BUFFER, player.vbo);
            this.gl.uniform3fv(this.gl.getUniformLocation(this.playerProgram, "uColor"), player.color);
            this.gl.drawArrays(this.gl.TRIANGLES, 0, 6 * player.segmentCount);
            player.segmentCount = 0;
        }

        requestAnimationFrame(() => this.renderLoop());
    }
}