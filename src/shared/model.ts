export type Point = [x: number, y: number]; 

export type Segment = [start: Point, end: Point];

export interface GameState {
    userID: string;
    lastSegment: Segment;
    pointCount: number;
}