import { Socket } from "socket.io-client";
import { Direction, DirectionInput, oppositeDirection } from "../shared/model";

export class InputManager {
    socket: Socket;
    keyMap: Map<string, Direction>;
    previousDirection: Direction | null = null;
    playing: boolean = false;

    constructor(socket: Socket) {
        this.socket = socket;
        this.keyMap = new Map<string, Direction>();
        this.keyMap.set("ArrowLeft", Direction.Left);
        this.keyMap.set("ArrowRight", Direction.Right);
        this.keyMap.set("ArrowUp", Direction.Up);
        this.keyMap.set("ArrowDown", Direction.Down);
    }
    
    private onKeyDown(e: KeyboardEvent) {
        if (!this.playing) {
            if (e.key === "Enter") {
                this.socket.emit("start");
            }
            return;
        }

        if (this.keyMap.has(e.key)) {
            const direction = this.keyMap.get(e.key)!;
            if (direction !== this.previousDirection && direction !== oppositeDirection(this.previousDirection)) {
                this.socket.emit("input", {
                    direction,
                    sentTimestamp: Date.now(),
                    receivedTimestamp: 0
                } as DirectionInput);
                this.previousDirection = direction;
            }
        }
    }

    start() {
        document.addEventListener('keydown', this.onKeyDown.bind(this));
    }

    setPlaying(playing: boolean) {
        this.playing = playing;
    }

    resetDirection() {
        this.previousDirection = null;
    }
}