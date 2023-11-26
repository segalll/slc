export type Point = [x: number, y: number];

export type Segment = [Point, Point];

export interface GameState {
    playing: boolean;
    players: PlayerState[];
}

export interface PlayerState {
    id: string;
    name: string;
    color: [number, number, number];
    score: number;
    missingSegments: Segment[];
}

export enum Direction {
    Up,
    Right,
    Down,
    Left
}

export const oppositeDirection = (direction: Direction | null) => {
    switch (direction) {
        case Direction.Up:
            return Direction.Down;
        case Direction.Right:
            return Direction.Left;
        case Direction.Down:
            return Direction.Up;
        case Direction.Left:
            return Direction.Right;
        default:
            return null;
    }
}

export interface GameSettings {
    aspectRatio: number;
    lineWidth: number;
}