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

export interface GameSettings {
    aspectRatio: number;
    lineWidth: number;
}