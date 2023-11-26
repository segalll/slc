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

export interface DirectionInput {
    direction: Direction;
    sentTimestamp: number;
    receivedTimestamp: number;
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

export const directionToVector = (direction: Direction) => {
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
}