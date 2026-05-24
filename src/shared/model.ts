export type Point = [x: number, y: number];

export type Segment = [Point, Point];

export interface PlayerInfo {
    id: string;
    index: number;
    name: string;
    color: [number, number, number];
    score: number;
}

export enum Direction {
    Up,
    Right,
    Down,
    Left
}

export const isDirection = (value: unknown): value is Direction => {
    return typeof value === "number" && Number.isInteger(value) && value >= Direction.Up && value <= Direction.Left;
}

export const directionToVector = (direction: Direction): [number, number] => {
    switch (direction) {
        case Direction.Up:
            return [0, 1];
        case Direction.Right:
            return [1, 0];
        case Direction.Down:
            return [0, -1];
        case Direction.Left:
            return [-1, 0];
    }
}

export interface GameSettings {
    aspectRatio: number;
    lineWidth: number;
    moveSpeed: number;
}
