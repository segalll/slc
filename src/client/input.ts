import { Socket } from "socket.io-client";
import { Direction } from "../shared/model";

export class InputManager {
    socket: Socket;
    keyMap: Map<string, Direction>;
    startX: number = 0;
    startY: number = 0;

    constructor(socket: Socket) {
        this.socket = socket;
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

    private onTouchEnd(e: TouchEvent) {
        const endX = e.changedTouches[0].clientX;
        const endY = e.changedTouches[0].clientY;
        const dx = endX - this.startX;
        const dy = endY - this.startY;
        if (Math.abs(dx) > Math.abs(dy)) {
            if (dx > 0) {
                this.socket.emit("input", Direction.Right);
            } else {
                this.socket.emit("input", Direction.Left);
            }
        } else {
            if (dy > 0) {
                this.socket.emit("input", Direction.Down);
            } else {
                this.socket.emit("input", Direction.Up);
            }
        }
    }
    
    private onKeyDown(e: KeyboardEvent) {
        if (e.key === "Enter") {
            this.socket.emit("start");
        }

        if (this.keyMap.has(e.key)) {
            const direction = this.keyMap.get(e.key)!;
            this.socket.emit("input", direction);
        }
    }

    start() {
        document.addEventListener('keydown', this.onKeyDown.bind(this));
        document.addEventListener('touchstart', this.onTouchStart.bind(this));
        document.addEventListener('touchend', this.onTouchEnd.bind(this));
    }
}