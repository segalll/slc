import type { Connection } from "./connection.js";
import { Direction } from "../shared/model";
import type { Renderer } from "./render";

export class InputManager {
    private socket: Connection;
    private renderer: Renderer;
    private keyMap: Map<string, Direction>;
    private startX: number = 0;
    private startY: number = 0;
    private started: boolean = false;

    constructor(socket: Connection, renderer: Renderer) {
        this.socket = socket;
        this.renderer = renderer;
        this.keyMap = new Map<string, Direction>();
        this.keyMap.set("ArrowLeft", Direction.Left);
        this.keyMap.set("ArrowRight", Direction.Right);
        this.keyMap.set("ArrowUp", Direction.Up);
        this.keyMap.set("ArrowDown", Direction.Down);
    }

    private onTouchStart(e: TouchEvent) {
        this.startX = e.touches[0].clientX;
        this.startY = e.touches[0].clientY;
    }

    private sendDirection(direction: Direction) {
        if (!this.socket.connected) return;
        const { seq, tick } = this.renderer.onLocalTurn(direction);
        this.socket.emit("input", { d: direction, s: seq, t: tick });
    }

    private onTouchEnd(e: TouchEvent) {
        const dx = e.changedTouches[0].clientX - this.startX;
        const dy = e.changedTouches[0].clientY - this.startY;
        if (Math.abs(dx) > Math.abs(dy)) {
            this.sendDirection(dx > 0 ? Direction.Right : Direction.Left);
        } else {
            this.sendDirection(dy > 0 ? Direction.Down : Direction.Up);
        }
    }

    private onKeyDown(e: KeyboardEvent) {
        if (e.key === "Enter") {
            this.socket.emit("start");
        }

        if (!e.repeat && this.keyMap.has(e.key)) {
            e.preventDefault();
            this.sendDirection(this.keyMap.get(e.key)!);
        }
    }

    start() {
        if (this.started) {
            return;
        }
        this.started = true;
        document.addEventListener('keydown', this.onKeyDown.bind(this));
        document.addEventListener('touchstart', this.onTouchStart.bind(this));
        document.addEventListener('touchend', this.onTouchEnd.bind(this));
    }
}
