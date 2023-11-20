export class Renderer {
    canvas: HTMLCanvasElement;
    gl: WebGL2RenderingContext;

    constructor() {
        const canvas = document.getElementById('game') as HTMLCanvasElement;
        const gl = canvas.getContext('webgl2') as WebGL2RenderingContext;

        const vertexShader = gl.createShader(gl.VERTEX_SHADER) as WebGLShader;
        gl.shaderSource(vertexShader,
            `#version 300 es
            #pragma vscode_glsllint_stage: vert
            precision highp float;
            in vec2 position;
            void main() {
                gl_Position = vec4(position, 0, 1);
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

        gl.clearColor(0, 0, 0, 1);

        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

        gl.canvas.width = canvas.clientWidth;
        gl.canvas.height = canvas.clientHeight;
        gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);

        this.canvas = canvas;
        this.gl = gl;
    }
    

    renderLoop() {
        this.gl.clear(this.gl.COLOR_BUFFER_BIT);
        this.gl.drawArrays(this.gl.TRIANGLE_FAN, 0, 4);
        requestAnimationFrame(() => this.renderLoop());
    }
}