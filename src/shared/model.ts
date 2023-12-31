export type Point = [x: number, y: number];

export type Segment = [Point, Point];

export const segmentsEqual = (a: Segment, b: Segment) => {
    return a[0][0] === b[0][0] && a[0][1] === b[0][1] && a[1][0] === b[1][0] && a[1][1] === b[1][1];
}

export interface GameState {
    players: PlayerState[];
    timestamp: number;
}

export interface PlayerState {
    id: string;
    missingSegments: Segment[];
    interpolated: boolean;
}

export interface PlayerInfo {
    id: string;
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

export interface DirectionInput {
    direction: Direction;
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