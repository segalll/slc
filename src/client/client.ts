import { io } from "socket.io-client";
import { Renderer } from "./render";
import { Direction, GameSettings, GameState } from "../shared/model";

const socket = io("http://localhost:9001", { autoConnect: false })

const attemptConnection = () => {
    const sessionID = localStorage.getItem("sessionID");
    if (sessionID) {
        socket.auth = { sessionID };
        socket.connect();
    } else {
        const usernameElement = document.createElement("input");
        usernameElement.type = "text";
        usernameElement.placeholder = "Player name...";
        usernameElement.autofocus = true;
        document.body.appendChild(usernameElement);

        usernameElement.addEventListener("keydown", (e) => {
            if (e.key === "Enter") {
                const username = usernameElement.value;
                socket.auth = { username };
                socket.connect();
            }
        })
    }
}

attemptConnection();

const renderer = new Renderer(socket, parseFloat(localStorage.getItem("aspectRatio") || "1.5"), 0.02);
let previousKey: string | null = null;

socket.on("session", ({ sessionID, userID }) => {
    localStorage.setItem("sessionID", sessionID);
    socket.auth = { sessionID };
    (socket as any).userID = userID;
    socket.connect();
})

socket.on("connect", () => {
    document.querySelector("input")?.remove();
    socket.emit("join");
    window.addEventListener("keydown", (e) => {
        if (e.key === "ArrowLeft" && previousKey !== "ArrowRight" && previousKey !== "ArrowLeft") {
            socket.emit("input", Direction.Left);
            previousKey = "ArrowLeft";
        } else if (e.key === "ArrowRight" && previousKey !== "ArrowLeft" && previousKey !== "ArrowRight") {
            socket.emit("input", Direction.Right);
            previousKey = "ArrowRight";
        } else if (e.key === "ArrowUp" && previousKey !== "ArrowDown" && previousKey !== "ArrowUp") {
            socket.emit("input", Direction.Up);
            previousKey = "ArrowUp";
        } else if (e.key === "ArrowDown" && previousKey !== "ArrowUp" && previousKey !== "ArrowDown") {
            socket.emit("input", Direction.Down);
            previousKey = "ArrowDown";
        }
    });
    renderer.renderLoop();
})

socket.on("game_settings", (gameSettings: GameSettings) => {
    localStorage.setItem("aspectRatio", gameSettings.aspectRatio.toString());
    renderer.updateAspectRatio(gameSettings.aspectRatio);
    renderer.updateLineWidth(gameSettings.lineWidth);
})

socket.on("connect_error", err => {
    if (err.message === "invalid session") {
        localStorage.removeItem("sessionID");
        attemptConnection();
    }
})

socket.on("game_state", (gameState: GameState) => {
    renderer.updatePlayer(gameState.userID, gameState.missingSegments);
})