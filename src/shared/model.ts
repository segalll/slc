export type Point = [x: number, y: number];

export type Segment = [Point, Point];

export type PortalPair = [Segment, Segment];

export const portalCapLineWidths = 6;

export const fieldShapes = ["rectangle", "circle", "octagon", "diamond", "triangle"] as const;

export type FieldShape = typeof fieldShapes[number];

export const isFieldShape = (value: unknown): value is FieldShape => {
    return typeof value === "string" && (fieldShapes as readonly string[]).includes(value);
}

export const gameStatePacket = {
    playerCountOffset: 0,
    playerCountBytes: 1,
    playerIndexOffset: 0,
    playerStartIndexOffset: 2,
    playerSegmentCountOffset: 4,
    playerHeaderBytes: 6,
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
    playerSegmentIndexOffset: 2,
    playerEndXOffset: 4,
    playerEndYOffset: 6,
    playerBytes: 8
} as const;

export const worldStatePacket = {
    segmentCountOffset: 0,
    segmentCountBytes: 2,
    segmentStartXOffset: 0,
    segmentStartYOffset: 2,
    segmentEndXOffset: 4,
    segmentEndYOffset: 6,
    segmentBytes: 8,
    portalPairCountBytes: 1,
    portalSegmentAOffset: 0,
    portalSegmentBOffset: 8,
    portalPairBytes: 16
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
    fieldShape: FieldShape;
    lineWidth: number;
    maxPortals: number;
    moveSpeed: number;
    obstacles: boolean;
    portals: boolean;
}
