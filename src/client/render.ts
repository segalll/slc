import { Socket } from "socket.io-client";
import { PlayerInfo, PlayerState, Segment } from "../shared/model";

interface Player {
    vao: WebGLVertexArrayObject;
    vbo: WebGLBuffer;
    name: string;
    color: [number, number, number];
    score: number;
    segmentCount: number;
}

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
    socket: Socket;
    gl: WebGL2RenderingContext;
    playerProgram: WebGLProgram;
    mvpUbo: WebGLBuffer;

    players: Map<string, Player>;

    aspectRatio: number;
    lineWidth: number;
    pendingRedraw: boolean;

    namesElement: HTMLElement;

    constructor(socket: Socket, aspectRatio: number, lineWidth: number) {
        const canvas = document.getElementById('game') as HTMLCanvasElement;
        const gl = canvas.getContext('webgl2', { preserveDrawingBuffer: true }) as WebGL2RenderingContext;

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

        gl.clearColor(0, 0, 0, 1);

        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

        this.socket = socket;
        this.gl = gl;
        this.players = new Map<string, Player>();

        this.aspectRatio = aspectRatio;
        this.lineWidth = lineWidth;
        this.pendingRedraw = false;

        this.namesElement = document.getElementById("names")!;

        this.resize();
    }

    updateAspectRatio(aspectRatio: number) {
        this.aspectRatio = aspectRatio;

        const projection = ortho(-aspectRatio, aspectRatio, -1, 1, -1, 1);
        this.gl.bindBuffer(this.gl.UNIFORM_BUFFER, this.mvpUbo);
        this.gl.bufferSubData(this.gl.UNIFORM_BUFFER, 0, new Float32Array(projection));
        this.gl.bindBuffer(this.gl.UNIFORM_BUFFER, null);

        this.resize();
    }

    updateLineWidth(lineWidth: number) {
        this.lineWidth = lineWidth;
    }

    removePlayer(id: string) {
        this.players.delete(id);
        this.namesElement.removeChild(document.getElementById(id)!);
        this.pendingRedraw = true;
    }

    resize() {
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

        // insane hack to get around browser clearing canvas on resize slightly after this function is called
        // this hopefully means we get our full player data again after the canvas is cleared
        // this is terrible. a better solution is to render to a framebuffer and then just render the framebuffer on the canvas
        // unfortunately, webgl decided it was going to filter my framebuffer even though i set the size to the EXACT size of the canvas
        // normally, filtering would be fine, but in this game with very thin lines, the lines just disappear entirely.
        // don't ask me why the framebuffer decided to filter. maybe floating point precision issues? but it doesn't make any sense.
        // the canvas itself is literally implemented with a framebuffer. i decide to create a framebuffer with the exact same size and it gets filtered.
        // anyway, this is my best solution. i could also just render all the vertices, but that's less efficient :(
        setTimeout(() => {
            this.socket.emit("redraw");
        }, 50);
    }

    prepareRound() {
        this.pendingRedraw = true;
    }

    modifyPlayer(playerInfo: PlayerInfo) {
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
            this.gl.bufferData(this.gl.ARRAY_BUFFER, 1024 * 512, this.gl.DYNAMIC_DRAW);

            this.gl.enableVertexAttribArray(0);
            this.gl.vertexAttribPointer(0, 2, this.gl.FLOAT, false, 0, 0);

            this.players.set(playerInfo.id, {
                vao: vao!,
                vbo: vbo!,
                name: playerInfo.name,
                color: playerInfo.color,
                score: playerInfo.score,
                segmentCount: 0
            });

            const nameElement = document.createElement("pre");
            nameElement.id = playerInfo.id;
            nameElement.innerText = `${playerInfo.name}: ${playerInfo.score}`;
            nameElement.style.color = `rgb(${Math.floor(playerInfo.color[0] * 255)}, ${Math.floor(playerInfo.color[1] * 255)}, ${Math.floor(playerInfo.color[2] * 255)})`;
            this.namesElement.appendChild(nameElement);
        }
    }

    updatePlayer(playerState: PlayerState) {
        const player = this.players.get(playerState.id)!;

        this.gl.bindVertexArray(player.vao);
        this.gl.bindBuffer(this.gl.ARRAY_BUFFER, player.vbo);
        const data = new Float32Array(12 * playerState.missingSegments.length);
        for (let i = 0; i < playerState.missingSegments.length; i++) {
            const p1 = playerState.missingSegments[i][0];
            const p2 = playerState.missingSegments[i][1];
            if (p1[0] === p2[0]) {
                data.set([
                    p1[0] - this.lineWidth, p1[1],
                    p1[0] + this.lineWidth, p1[1],
                    p2[0] - this.lineWidth, p2[1],
                    p2[0] - this.lineWidth, p2[1],
                    p1[0] + this.lineWidth, p1[1],
                    p2[0] + this.lineWidth, p2[1]
                ], 6 * 2 * i);
            } else {
                data.set([
                    p1[0], p1[1] - this.lineWidth,
                    p1[0], p1[1] + this.lineWidth,
                    p2[0], p2[1] - this.lineWidth,
                    p2[0], p2[1] - this.lineWidth,
                    p1[0], p1[1] + this.lineWidth,
                    p2[0], p2[1] + this.lineWidth
                ], 6 * 2 * i);
            }
        }
        this.gl.bufferSubData(this.gl.ARRAY_BUFFER, 12 * 4 * player.segmentCount, data);

        player.segmentCount += playerState.missingSegments.length;
    }
    
    renderLoop() {
        this.resize();

        if (this.pendingRedraw) {
            this.pendingRedraw = false;
            this.gl.clear(this.gl.COLOR_BUFFER_BIT);
            this.socket.emit("redraw");
        }

        this.gl.useProgram(this.playerProgram);
        for (const player of this.players.values()) {
            if (player.segmentCount === 0) {
                continue;
            }
            this.gl.bindVertexArray(player.vao);
            this.gl.bindBuffer(this.gl.ARRAY_BUFFER, player.vbo);
            this.gl.uniform3fv(this.gl.getUniformLocation(this.playerProgram, "uColor"), player.color);
            this.gl.drawArrays(this.gl.TRIANGLES, 0, 6 * player.segmentCount);
            player.segmentCount = 0;
        }

        requestAnimationFrame(() => this.renderLoop());
    }
}