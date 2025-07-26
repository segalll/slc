import { Socket } from "socket.io-client";
import { Direction } from "../shared/model";

interface TouchState {
    startX: number;
    startY: number;
}

export class InputManager {
    private readonly socket: Socket;
    private readonly keyMap: Map<string, Direction>;
    private readonly touchState: TouchState;

    constructor(socket: Socket) {
        this.socket = socket;
        this.keyMap = new Map<string, Direction>([
            ["ArrowLeft", Direction.Left],
            ["ArrowRight", Direction.Right],
            ["ArrowUp", Direction.Up],
            ["ArrowDown", Direction.Down]
        ]);
        this.touchState = { startX: 0, startY: 0 };
    }

    private onTouchStart = (e: TouchEvent): void => {
        this.touchState.startX = e.touches[0].clientX;
        this.touchState.startY = e.touches[0].clientY;
    };

    private onTouchEnd = (e: TouchEvent): void => {
        const endX = e.changedTouches[0].clientX;
        const endY = e.changedTouches[0].clientY;
        const dx = endX - this.touchState.startX;
        const dy = endY - this.touchState.startY;
        
        const direction = Math.abs(dx) > Math.abs(dy) 
            ? (dx > 0 ? Direction.Right : Direction.Left)
            : (dy > 0 ? Direction.Down : Direction.Up);
            
        this.socket.emit("input", direction);
    };
    
    private onKeyDown = (e: KeyboardEvent): void => {
        if (e.key === "Enter") {
            this.socket.emit("start");
            return;
        }

        const direction = this.keyMap.get(e.key);
        if (direction !== undefined) {
            this.socket.emit("input", direction);
        }
    };

    start(): void {
        document.addEventListener('keydown', this.onKeyDown);
        document.addEventListener('touchstart', this.onTouchStart);
        document.addEventListener('touchend', this.onTouchEnd);
    }
}