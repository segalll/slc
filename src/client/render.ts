import { Segments } from "../shared/model";

interface Player {
    vao: WebGLVertexArrayObject;
    vbo: WebGLBuffer;
    segment_count: number;
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
    gl: WebGL2RenderingContext;
    players: Map<string, Player>;
    mvpUbo: WebGLBuffer;
    aspectRatio: number;
    lineWidth: number = 0.001;

    constructor(aspectRatio: number) {
        const canvas = document.getElementById('game') as HTMLCanvasElement;
        const gl = canvas.getContext('webgl2') as WebGL2RenderingContext;

        const vertexShader = gl.createShader(gl.VERTEX_SHADER) as WebGLShader;
        gl.shaderSource(vertexShader,
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
        gl.compileShader(vertexShader);

        const fragmentShader = gl.createShader(gl.FRAGMENT_SHADER) as WebGLShader;
        gl.shaderSource(fragmentShader,
            `#version 300 es
            #pragma vscode_glsllint_stage: frag
            precision lowp float;
            out vec4 color;
            void main() {
                color = vec4(1, 0, 0, 1);
            }`
        );
        gl.compileShader(fragmentShader);
        const program = gl.createProgram() as WebGLProgram;
        gl.attachShader(program, vertexShader);
        gl.attachShader(program, fragmentShader);
        gl.linkProgram(program);
        gl.useProgram(program);

        const mvpBlockIndex = gl.getUniformBlockIndex(program, "MVP");
        const mvpBlockSize = gl.getActiveUniformBlockParameter(program, mvpBlockIndex, gl.UNIFORM_BLOCK_DATA_SIZE);
        this.mvpUbo = gl.createBuffer()!;
        gl.bindBuffer(gl.UNIFORM_BUFFER, this.mvpUbo);
        gl.bufferData(gl.UNIFORM_BUFFER, mvpBlockSize, gl.DYNAMIC_DRAW);
        gl.bindBuffer(gl.UNIFORM_BUFFER, null);
        gl.bindBufferBase(gl.UNIFORM_BUFFER, 0, this.mvpUbo);
        gl.uniformBlockBinding(program, mvpBlockIndex, 0);

        gl.clearColor(0, 0, 0, 1);

        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

        this.gl = gl;
        this.players = new Map<string, Player>();
        this.aspectRatio = aspectRatio;

        this.resize();
    }

    updateAspectRatio(aspectRatio: number) {
        this.aspectRatio = aspectRatio;
        const projection = ortho(-aspectRatio, aspectRatio, -1, 1, -1, 1);
        this.gl.bindBuffer(this.gl.UNIFORM_BUFFER, this.mvpUbo);
        this.gl.bufferSubData(this.gl.UNIFORM_BUFFER, 0, new Float32Array(projection));
        this.gl.bindBuffer(this.gl.UNIFORM_BUFFER, null);
    }

    resize() {
        const newWidth = window.innerWidth - 4;
        const newHeight = window.innerHeight - 4;

        if (Math.abs((this.gl.canvas.width / this.gl.canvas.height) - this.aspectRatio) < 0.002 &&
            (this.gl.canvas.width === newWidth || this.gl.canvas.height === newHeight) && this.gl.canvas.width <= newWidth && this.gl.canvas.height <= newHeight) {
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

    updatePlayer(id: string, missingSegments: Segments, missingSegmentStartIndex: number) {
        if (!this.players.has(id)) {
            const vao = this.gl.createVertexArray();
            this.gl.bindVertexArray(vao);
            
            const vbo = this.gl.createBuffer();
            this.gl.bindBuffer(this.gl.ARRAY_BUFFER, vbo);
            this.gl.bufferData(this.gl.ARRAY_BUFFER, 1024 * 512, this.gl.DYNAMIC_DRAW);

            this.gl.enableVertexAttribArray(0);
            this.gl.vertexAttribPointer(0, 2, this.gl.FLOAT, false, 0, 0);

            this.players.set(id, {
                vao: vao!,
                vbo: vbo!,
                segment_count: 1
            });
        }
        const player = this.players.get(id)!;
        player.segment_count = missingSegmentStartIndex + missingSegments.length - 1;

        this.gl.bindVertexArray(player.vao);
        this.gl.bindBuffer(this.gl.ARRAY_BUFFER, player.vbo);
        const data = new Float32Array(12 * (missingSegments.length - 1));
        for (let i = 0; i < missingSegments.length - 1; i++) {
            if (missingSegments[i][0] === missingSegments[i + 1][0]) {
                data.set([
                    missingSegments[i][0] - this.lineWidth, missingSegments[i][1],
                    missingSegments[i][0] + this.lineWidth, missingSegments[i][1],
                    missingSegments[i + 1][0] - this.lineWidth, missingSegments[i + 1][1],
                    missingSegments[i + 1][0] - this.lineWidth, missingSegments[i + 1][1],
                    missingSegments[i][0] + this.lineWidth, missingSegments[i][1],
                    missingSegments[i + 1][0] + this.lineWidth, missingSegments[i + 1][1]
                ], 6 * 2 * i);
            } else {
                data.set([
                    missingSegments[i][0], missingSegments[i][1] - this.lineWidth,
                    missingSegments[i][0], missingSegments[i][1] + this.lineWidth,
                    missingSegments[i + 1][0], missingSegments[i + 1][1] - this.lineWidth,
                    missingSegments[i + 1][0], missingSegments[i + 1][1] - this.lineWidth,
                    missingSegments[i][0], missingSegments[i][1] + this.lineWidth,
                    missingSegments[i + 1][0], missingSegments[i + 1][1] + this.lineWidth
                ], 6 * 2 * i);
            }
        }
        this.gl.bufferSubData(this.gl.ARRAY_BUFFER, 8 * 6 * missingSegmentStartIndex, data);
        this.gl.bindVertexArray(null);
    }
    
    renderLoop() {
        this.resize();
        this.gl.clear(this.gl.COLOR_BUFFER_BIT);
        for (const player of this.players.values()) {
            this.gl.bindVertexArray(player.vao);
            this.gl.bindBuffer(this.gl.ARRAY_BUFFER, player.vbo);
            this.gl.drawArrays(this.gl.TRIANGLES, 0, 6 * player.segment_count);
        }
        requestAnimationFrame(() => this.renderLoop());
    }
}