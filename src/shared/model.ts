export type Point = [x: number, y: number];

export type Segment = [Point, Point];

export const gameStatePacket = {
    playerCountOffset: 0,
    playerCountBytes: 1,
    playerIndexOffset: 0,
    playerStartIndexOffset: 1,
    playerSegmentCountOffset: 3,
    playerHeaderBytes: 5,
    segmentStartXOffset: 0,
    segmentStartYOffset: 2,
    segmentEndXOffset: 4,
    segmentEndYOffset: 6,
    segmentBytes: 8
} as const;

export const gameTailPacket = {
    playerCountOffset: 0,
    playerCountBytes: 1,
    playerIndexOffset: 0,
    playerSegmentIndexOffset: 1,
    playerEndXOffset: 3,
    playerEndYOffset: 5,
    playerBytes: 7
} as const;

export const uint16Max = 0xffff;

export const coordToUint16 = (value: number, min: number, max: number) => {
    const clamped = Math.min(Math.max(value, min), max);
    return Math.round(((clamped - min) / (max - min)) * uint16Max);
}

export const uint16ToCoord = (value: number, min: number, max: number) => {
    return min + (value / uint16Max) * (max - min);
}

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
