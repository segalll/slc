import { io } from "socket.io-client";
import { Renderer } from "./render";
import { InputManager } from "./input";
import { GameSettings, GameState, PlayerInfo, GAME_CONSTANTS } from "../shared/model";

const socket = io(window.location.toString(), { autoConnect: false });

const hslToRgbHex = (h: number, s: number, l: number): string => {
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs((h / 60) % 2 - 1));
    const m = l - c / 2;
    const rgb = h < 60 ? [c, x, 0] :
        h < 120 ? [x, c, 0] :
            h < 180 ? [0, c, x] :
                h < 240 ? [0, x, c] :
                    h < 300 ? [x, 0, c] :
                        [c, 0, x];
    return "#" + rgb.map(v => Math.floor((v + m) * 255).toString(16).padStart(2, "0")).join("");
};

const randomColorWithSL = (s: number, l: number): string => {
    const h = Math.random() * 360;
    return hslToRgbHex(h, s, l);
};

const createJoinForm = (): void => {
    const joinDataElement = document.createElement("div");
    joinDataElement.id = "join-data";

    const colorElement = document.createElement("input");
    colorElement.id = "color";
    colorElement.type = "color";
    colorElement.value = randomColorWithSL(1, 0.5);
    joinDataElement.appendChild(colorElement);

    const usernameElement = document.createElement("input");
    usernameElement.id = "name";
    usernameElement.type = "text";
    usernameElement.placeholder = "Player name...";
    usernameElement.autofocus = true;
    joinDataElement.appendChild(usernameElement);

    document.body.appendChild(joinDataElement);

    usernameElement.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
            const username = usernameElement.value;
            const color = colorElement.value;
            socket.auth = { username, color };
            socket.connect();
        }
    });
};

const attemptConnection = (): void => {
    const sessionID = localStorage.getItem("sessionID");
    if (sessionID) {
        socket.auth = { sessionID };
        socket.connect();
    } else {
        createJoinForm();
    }
};

const initializeAudio = (): { roundOver: HTMLAudioElement; countdown: HTMLAudioElement } => {
    const roundOver = new Audio("/snd/round_over.wav");
    roundOver.volume = 0.5;
    
    const countdown = new Audio("/snd/countdown.wav");
    countdown.volume = 0.5;
    
    return { roundOver, countdown };
};

const setupSocketHandlers = (
    renderer: Renderer, 
    inputManager: InputManager, 
    audio: { roundOver: HTMLAudioElement; countdown: HTMLAudioElement }
): void => {
    socket.on("session", (sessionID: string) => {
        localStorage.setItem("sessionID", sessionID);
        socket.auth = { sessionID };
        socket.connect();
    });

    socket.on("connect", () => {
        setInterval(() => {
            socket.emit("heartbeat");
        }, GAME_CONSTANTS.HEARTBEAT_INTERVAL);

        document.getElementById("join-data")?.remove();
        socket.emit("join");
        inputManager.start();
        renderer.renderLoop();
    });

    socket.on("game_settings", (gameSettings: GameSettings) => {
        localStorage.setItem("aspectRatio", gameSettings.aspectRatio.toString());
        renderer.updateGameSettings(gameSettings);
    });

    socket.on("connect_error", (err) => {
        if (err.message === "invalid session") {
            localStorage.removeItem("sessionID");
            attemptConnection();
        }
    });

    socket.on("game_state", (gameState: GameState) => {
        for (const player of gameState.players) {
            renderer.updatePlayer(player);
        }
    });

    socket.on("modify_player", (playerInfo: PlayerInfo) => {
        renderer.modifyPlayer(playerInfo);
    });

    socket.on("remove", (id: string) => {
        renderer.removePlayer(id);
    });

    socket.on("starting", () => {
        renderer.prepareRound();
        audio.countdown.play();
    });

    socket.on("round_over", () => {
        audio.roundOver.play();
    });
};

attemptConnection();

const renderer = new Renderer(socket, parseFloat(localStorage.getItem("aspectRatio") || GAME_CONSTANTS.DEFAULT_ASPECT_RATIO.toString()));
const inputManager = new InputManager(socket);
const audio = initializeAudio();

setupSocketHandlers(renderer, inputManager, audio);