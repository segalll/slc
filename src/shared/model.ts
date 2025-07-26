export type Point = [x: number, y: number];

export type Segment = [Point, Point];

export interface GameState {
    players: PlayerState[];
}

export interface PlayerState {
    id: string;
    missingSegments: Segment[];
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

export interface GameSettings {
    aspectRatio: number;
    lineWidth: number;
}

export const GAME_CONSTANTS = {
    DEFAULT_ASPECT_RATIO: 1.5,
    DEFAULT_LINE_WIDTH: 0.002,
    MIN_SPAWN_DISTANCE_FROM_EDGE: 0.1,
    MOVE_SPEED: 0.3,
    TICK_RATE: 30,
    SUB_TICK_RATE: 2,
    NUM_PARTITIONS: 10,
    ROUND_START_DELAY: 3000,
    SESSION_TIMEOUT: 3000,
    HEARTBEAT_INTERVAL: 1000,
    CANVAS_RESIZE_DELAY: 50,
    REDRAW_DELAY: 50
} as const;

export const VECTORS: Record<Direction, Point> = {
    [Direction.Up]: [0, 1],
    [Direction.Right]: [1, 0],
    [Direction.Down]: [0, -1],
    [Direction.Left]: [-1, 0]
} as const;

export const oppositeDirection = (direction: Direction | null): Direction | null => {
    if (direction === null) return null;
    
    const opposites: Record<Direction, Direction> = {
        [Direction.Up]: Direction.Down,
        [Direction.Right]: Direction.Left,
        [Direction.Down]: Direction.Up,
        [Direction.Left]: Direction.Right
    };
    
    return opposites[direction];
};

export const directionToVector = (direction: Direction): Point => {
    return VECTORS[direction];
};

export const isValidDirectionChange = (currentDirection: Direction, newDirection: Direction): boolean => {
    const lastDirection = directionToVector(currentDirection);
    
    return !(newDirection === Direction.Right && lastDirection[1] === 0.0) &&
           !(newDirection === Direction.Up && lastDirection[0] === 0.0) &&
           !(newDirection === Direction.Down && lastDirection[0] === 0.0) &&
           !(newDirection === Direction.Left && lastDirection[1] === 0.0);
};