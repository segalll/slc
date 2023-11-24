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
        const joinDataElement = document.createElement("div");
        joinDataElement.id = "join-data";

        const colorElement = document.createElement("input");
        colorElement.id = "color";
        colorElement.type = "color";
        colorElement.value = "#000000";
        joinDataElement.appendChild(colorElement);

        const usernameElement = document.createElement("input");
        usernameElement.id = "name";
        usernameElement.type = "text";
        usernameElement.placeholder = "Player name...";
        usernameElement.autofocus = true;
        joinDataElement.appendChild(usernameElement);

        document.body.appendChild(joinDataElement)

        usernameElement.addEventListener("keydown", (e) => {
            if (e.key === "Enter") {
                const username = usernameElement.value;
                const color = colorElement.value;
                socket.auth = { username, color };
                socket.connect();
            }
        })
    }
}

attemptConnection();

const renderer = new Renderer(socket, parseFloat(localStorage.getItem("aspectRatio") || "1.5"), 0.02);
let previousKey: string = "";
let playing = false;

socket.on("session", ({ sessionID, userID }) => {
    localStorage.setItem("sessionID", sessionID);
    socket.auth = { sessionID };
    (socket as any).userID = userID;
    socket.connect();
})

socket.on("connect", () => {
    document.getElementById("join-data")!.remove();
    socket.emit("join");
    window.addEventListener("keydown", (e) => {
        if (!playing) {
            if (e.key === "Enter") {
                socket.emit("start");
            }
            return;
        }

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
    playing = gameState.playing;
    for (const player of gameState.players) {
        renderer.updatePlayer(player);
    }
})

socket.on("remove", (id: string) => {
    renderer.removePlayer(id);
})

socket.on("starting", () => {
    renderer.prepareRound();
    previousKey = "";
})