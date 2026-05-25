import { portalCapLineWidths, type FieldShape, type Point, type Segment } from "./model.js";

const circleSides = 96;
const epsilon = 0.0000001;

const buildPolygonSegments = (vertices: Point[]): Segment[] => {
    return vertices.map((point, i) => [point, vertices[(i + 1) % vertices.length]] as Segment);
}

const buildRegularPolygon = (sides: number, xRadius: number, yRadius: number, rotation: number) => {
    const vertices: Point[] = [];
    for (let i = 0; i < sides; i++) {
        const angle = rotation + i * Math.PI * 2 / sides;
        vertices.push([Math.cos(angle) * xRadius, Math.sin(angle) * yRadius]);
    }
    return buildPolygonSegments(vertices);
}

export const getFieldMinRadius = (aspectRatio: number) => Math.min(aspectRatio, 1);

export const buildFieldSegments = (aspectRatio: number, fieldShape: FieldShape): Segment[] => {
    switch (fieldShape) {
        case "rectangle":
            return buildPolygonSegments([
                [-aspectRatio, -1],
                [aspectRatio, -1],
                [aspectRatio, 1],
                [-aspectRatio, 1]
            ]);
        case "circle":
            return buildRegularPolygon(circleSides, aspectRatio, 1, 0);
        case "octagon":
            return buildRegularPolygon(8, aspectRatio, 1, Math.PI / 8);
        case "diamond":
            return buildRegularPolygon(4, aspectRatio, 1, 0);
        case "triangle":
            return buildRegularPolygon(3, aspectRatio, 1, Math.PI / 2);
    }
}

export const pointToSegmentDistanceSq = (point: Point, segment: Segment) => {
    const dx = segment[1][0] - segment[0][0];
    const dy = segment[1][1] - segment[0][1];
    const lengthSq = dx * dx + dy * dy;
    if (lengthSq === 0) {
        const px = point[0] - segment[0][0];
        const py = point[1] - segment[0][1];
        return px * px + py * py;
    }

    const t = Math.max(0, Math.min(1, ((point[0] - segment[0][0]) * dx + (point[1] - segment[0][1]) * dy) / lengthSq));
    const closestX = segment[0][0] + t * dx;
    const closestY = segment[0][1] + t * dy;
    const px = point[0] - closestX;
    const py = point[1] - closestY;
    return px * px + py * py;
}

export const segmentToQuad = (segment: Segment, width: number): Point[] | null => {
    const dx = segment[1][0] - segment[0][0];
    const dy = segment[1][1] - segment[0][1];
    const length = Math.hypot(dx, dy);
    if (length === 0) {
        return null;
    }

    const nx = -dy / length * width;
    const ny = dx / length * width;
    return [
        [segment[0][0] + nx, segment[0][1] + ny],
        [segment[1][0] + nx, segment[1][1] + ny],
        [segment[1][0] - nx, segment[1][1] - ny],
        [segment[0][0] - nx, segment[0][1] - ny]
    ];
}

export const getPortalCapSegments = (segment: Segment, lineWidth: number): Segment[] => {
    const dx = segment[1][0] - segment[0][0];
    const dy = segment[1][1] - segment[0][1];
    const length = Math.hypot(dx, dy);
    if (length === 0) {
        return [];
    }

    const nx = -dy / length;
    const ny = dx / length;
    const capHalfLength = lineWidth * portalCapLineWidths / 2;
    return [
        [
            [segment[0][0] - nx * capHalfLength, segment[0][1] - ny * capHalfLength],
            [segment[0][0] + nx * capHalfLength, segment[0][1] + ny * capHalfLength]
        ],
        [
            [segment[1][0] - nx * capHalfLength, segment[1][1] - ny * capHalfLength],
            [segment[1][0] + nx * capHalfLength, segment[1][1] + ny * capHalfLength]
        ]
    ];
}

export const getConvexHull = (points: Point[]) => {
    const sorted = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const cross = (o: Point, a: Point, b: Point) => {
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    }
    const lower: Point[] = [];
    for (const point of sorted) {
        while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], point) <= 0) {
            lower.pop();
        }
        lower.push(point);
    }

    const upper: Point[] = [];
    for (let i = sorted.length - 1; i >= 0; i--) {
        const point = sorted[i];
        while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], point) <= 0) {
            upper.pop();
        }
        upper.push(point);
    }

    lower.pop();
    upper.pop();
    return lower.concat(upper);
}

export const getSegmentIntersection = (line1: Segment, line2: Segment): Point | null => {
    const rX = line1[1][0] - line1[0][0];
    const rY = line1[1][1] - line1[0][1];
    const sX = line2[1][0] - line2[0][0];
    const sY = line2[1][1] - line2[0][1];
    const denominator = rX * sY - rY * sX;
    if (Math.abs(denominator) < epsilon) {
        return null;
    }

    const qmpX = line2[0][0] - line1[0][0];
    const qmpY = line2[0][1] - line1[0][1];
    const t = (qmpX * sY - qmpY * sX) / denominator;
    const u = (qmpX * rY - qmpY * rX) / denominator;
    if (t < -epsilon || t > 1 + epsilon || u < -epsilon || u > 1 + epsilon) {
        return null;
    }

    return [line1[0][0] + rX * t, line1[0][1] + rY * t];
}

export const isPointInPolygon = (point: Point, vertices: Point[]) => {
    let inside = false;
    for (let i = 0, j = vertices.length - 1; i < vertices.length; j = i++) {
        const [xi, yi] = vertices[i];
        const [xj, yj] = vertices[j];
        const intersects = yi > point[1] !== yj > point[1] &&
            point[0] < (xj - xi) * (point[1] - yi) / (yj - yi) + xi;
        if (intersects) {
            inside = !inside;
        }
    }
    return inside;
}

export const isPointInField = (point: Point, fieldSegments: Segment[], margin: number = 0) => {
    const onBoundary = fieldSegments.some(segment => pointToSegmentDistanceSq(point, segment) <= epsilon * epsilon);
    if (onBoundary) {
        return margin <= 0;
    }

    const inside = isPointInPolygon(point, fieldSegments.map(segment => segment[0]));
    if (!inside) {
        return false;
    }

    if (margin > 0) {
        const minDistanceSq = margin * margin;
        for (const segment of fieldSegments) {
            if (pointToSegmentDistanceSq(point, segment) <= minDistanceSq) {
                return false;
            }
        }
    }
    return true;
}

export const isSegmentInField = (segment: Segment, fieldSegments: Segment[], margin: number = 0) => {
    return isPointInField(segment[0], fieldSegments, margin) && isPointInField(segment[1], fieldSegments, margin);
}
