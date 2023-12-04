import { Socket } from "socket.io-client";
import { Direction } from "../shared/model";

export class InputManager {
    socket: Socket;
    keyMap: Map<string, Direction>;

    constructor(socket: Socket) {
        this.socket = socket;
        this.keyMap = new Map<string, Direction>();
        this.keyMap.set("ArrowLeft", Direction.Left);
        this.keyMap.set("ArrowRight", Direction.Right);
        this.keyMap.set("ArrowUp", Direction.Up);
        this.keyMap.set("ArrowDown", Direction.Down);
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
    }
}