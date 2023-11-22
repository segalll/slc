export type Point = [x: number, y: number];

export type Segments = [Point, Point, ...Point[]]; // at least two points

export interface GameState {
    userID: string;
    missingSegments: Segments;
    missingSegmentStartIndex: number;
}

export enum Direction {
    Up,
    Right,
    Down,
    Left
}