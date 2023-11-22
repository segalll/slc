import { io } from "socket.io-client";
import { Renderer } from "./render";
import { Direction, GameState } from "../shared/model";

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

const renderer = new Renderer(parseFloat(localStorage.getItem("aspectRatio") || "1.5"));

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
        if (e.key === "ArrowLeft") {
            socket.emit("input", Direction.Left);
        } else if (e.key === "ArrowRight") {
            socket.emit("input", Direction.Right);
        } else if (e.key === "ArrowUp") {
            socket.emit("input", Direction.Up);
        } else if (e.key === "ArrowDown") {
            socket.emit("input", Direction.Down);
        }
    });
    renderer.renderLoop();
})

socket.on("aspect_ratio", (aspectRatio: number) => {
    localStorage.setItem("aspectRatio", aspectRatio.toString());
    renderer.updateAspectRatio(aspectRatio);
})

socket.on("connect_error", err => {
    if (err.message === "invalid session") {
        localStorage.removeItem("sessionID");
        attemptConnection();
    }
})

socket.on("game_state", (gameState: GameState) => {
    renderer.updatePlayer(gameState.userID, gameState.missingSegments, gameState.missingSegmentStartIndex);
})