import { io } from "socket.io-client";
import { Renderer } from "./render";

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

socket.on("session", ({ sessionID, userID }) => {
    localStorage.setItem("sessionID", sessionID);
    socket.auth = { sessionID };
    (socket as any).userID = userID;
    socket.connect();
})

socket.on("connect", () => {
    document.querySelector("input")?.remove();
    const renderer = new Renderer();
    renderer.renderLoop();
    socket.emit("join");
})

socket.on("connect_error", err => {
    if (err.message === "invalid session") {
        localStorage.removeItem("sessionID");
        attemptConnection();
    }
})