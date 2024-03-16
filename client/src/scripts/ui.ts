import { sound } from "@pixi/sound";
import $ from "jquery";
import { Color, isMobile, isWebGPUSupported } from "pixi.js";
import { GameConstants, InputActions, SpectateActions, TeamSize } from "../../../common/src/constants";
import { Ammos } from "../../../common/src/definitions/ammos";
import { Badges } from "../../../common/src/definitions/badges";
import { Emotes } from "../../../common/src/definitions/emotes";
import { HealType, HealingItems } from "../../../common/src/definitions/healingItems";
import { Scopes } from "../../../common/src/definitions/scopes";
import { Skins } from "../../../common/src/definitions/skins";
import { SpectatePacket } from "../../../common/src/packets/spectatePacket";
import { ItemType } from "../../../common/src/utils/objectDefinitions";
import { type Game } from "./game";
import { body, createDropdown } from "./uiHelpers";
import { defaultClientCVars, type CVarTypeMapping } from "./utils/console/defaultClientCVars";
import { UI_DEBUG_MODE, emoteSlots } from "./utils/constants";
import { Crosshairs, getCrosshair } from "./utils/crosshairs";
import { dropItemListener, requestFullscreen } from "./utils/misc";
import { pickRandomInArray } from "../../../common/src/utils/random";
import { Config } from "./config";

interface RegionInfo {
    name: string
    address: string
    https: boolean
    playerCount?: number
    maxTeamSize?: number
    ping?: number
}

let selectedRegion: RegionInfo;

const regionInfo: Record<string, RegionInfo> = Config.regions;

export function resetPlayButtons(): void {
    $("#splash-options").removeClass("loading");
    const info = selectedRegion ?? regionInfo[Config.defaultRegion];
    $("#btn-play-solo").toggleClass("btn-disabled", info.maxTeamSize !== TeamSize.Solo);
    $("#btn-play-duo, #btn-create-team, #btn-join-team").toggleClass("btn-disabled", info.maxTeamSize !== TeamSize.Duo);
}

export async function setupUI(game: Game): Promise<void> {
    if (UI_DEBUG_MODE) {
        // Kill message
        $("#kill-msg-kills").text("Kills: 7");
        $("#kill-msg-player-name").html("Player");
        $("#kill-msg-weapon-used").text(" with Mosin-Nagant (streak: 255)");
        $("#kill-msg").show();

        // Spectating message
        $("#spectating-msg-player").html("Player");
        $("#spectating-container").show();

        // Gas message
        $("#gas-msg-info")
            .text("Toxic gas is advancing! Move to the safe zone")
            .css("color", "cyan");
        $("#gas-msg").show();

        $("#weapon-ammo-container").show();

        // Kill feed messages
        for (let i = 0; i < 5; i++) {
            const killFeedItem = $("<div>");
            killFeedItem.addClass("kill-feed-item");
            // noinspection HtmlUnknownTarget
            killFeedItem.html(
                '<img class="kill-icon" src="./img/misc/skull_icon.svg" alt="Skull"> Player killed Player with Mosin-Nagant'
            );
            $("#kill-feed").prepend(killFeedItem);
        }
    }

    // createDropdown("#splash-more");

    const regionMap = Object.entries(regionInfo);
    const serverList = $("#server-list");

    // Load server list
    for (const [regionID, region] of regionMap) {
        const listItem = $(`
                <li class="server-list-item" data-region="${regionID}">
                    <span class="server-name">${region.name}</span>
                    <span style="margin-left: auto">
                      <img src="./img/misc/player_icon.svg" width="16" height="16" alt="Player count">
                      <span class="server-player-count">-</span>
                    </span>
                </li>
            `);
        /* <span style="margin-left: 5px">
          <img src="./img/misc/ping_icon.svg" width="16" height="16" alt="Ping">
          <span class="server-ping">-</span>
        </span> */
        serverList.append(listItem);
    }

    // Get player counts + find server w/ best ping
    let bestPing = Number.MAX_VALUE;
    let bestRegion: string | undefined;
    const loadServers = async(): Promise<void> => {
        for (const [regionID, region] of regionMap) {
            const listItem = $(`.server-list-item[data-region=${regionID}]`);
            try {
                const pingStartTime = Date.now();
                const serverInfo = await (await fetch(`http${region.https ? "s" : ""}://${region.address}/api/serverInfo`, { signal: AbortSignal.timeout(2000) }))?.json();
                const ping = Date.now() - pingStartTime;

                if (serverInfo.protocolVersion !== GameConstants.protocolVersion) {
                    listItem.addClass("server-list-item-disabled");
                    console.error(`Protocol version mismatch for region ${regionID}. Expected ${GameConstants.protocolVersion}, got ${serverInfo.protocolVersion}`);
                    continue;
                }

                regionInfo[regionID] = {
                    ...region,
                    ...serverInfo,
                    ping
                };

                listItem.find(".server-player-count").text(serverInfo.playerCount ?? "-");
                // listItem.find(".server-ping").text(typeof playerCount === "string" ? ping : "-");

                if (ping < bestPing) {
                    bestPing = ping;
                    bestRegion = regionID;
                }
            } catch (e) {
                listItem.addClass("server-list-item-disabled");
                console.error(`Failed to load server info for region ${regionID}. Details:`, e);
            }
        }
    };

    const updateServerSelector = (): void => {
        if (!selectedRegion) { // Handle invalid region
            selectedRegion = regionInfo[Config.defaultRegion];
            game.console.setBuiltInCVar("cv_region", "");
        }
        $("#server-name").text(selectedRegion.name);
        $("#server-player-count").text(selectedRegion.playerCount ?? "-");
        // $("#server-ping").text(selectedRegion.ping && selectedRegion.ping > 0 ? selectedRegion.ping : "-");
    };

    const region = game.console.getBuiltInCVar("cv_region");
    if (region) {
        void (async() => {
            await loadServers();
            selectedRegion = regionInfo[region];
            updateServerSelector();
        })();
        selectedRegion = regionInfo[region];
    } else {
        await loadServers();
        selectedRegion = regionInfo[bestRegion ?? Config.defaultRegion];
    }
    updateServerSelector();

    // eslint-disable-next-line @typescript-eslint/no-misused-promises
    serverList.children("li.server-list-item").on("click", async function(this: HTMLLIElement) {
        const region = this.getAttribute("data-region");

        if (region === null) return;

        const info = regionInfo[region];
        if (info === undefined) return;

        resetPlayButtons();

        selectedRegion = info;

        game.console.setBuiltInCVar("cv_region", region);

        updateServerSelector();
    });

    let lastPlayButtonClickTime = 0;

    // Join server when play button is clicked
    const addPlayButtonClickHandler = (button: JQuery): void => {
        button.on("click", () => {
            const now = Date.now();
            if (now - lastPlayButtonClickTime < 1500) return; // Play button rate limit
            lastPlayButtonClickTime = now;
            $("#splash-options").addClass("loading");
            const urlPart = `${selectedRegion.https ? "s" : ""}://${selectedRegion.address}`;
            void $.get(`http${urlPart}/api/getGame`, (data: { success: boolean, message?: "rateLimit" | "warning" | "tempBan" | "permaBan", gameID: number }) => {
                if (data.success) {
                    let address = `ws${urlPart}/play?gameID=${data.gameID}`;

                    const devPass = game.console.getBuiltInCVar("dv_password");
                    const role = game.console.getBuiltInCVar("dv_role");
                    const lobbyClearing = game.console.getBuiltInCVar("dv_lobby_clearing");
                    const weaponPreset = game.console.getBuiltInCVar("dv_weapon_preset");

                    if (devPass) address += `&password=${devPass}`;
                    if (role) address += `&role=${role}`;
                    if (lobbyClearing) address += "&lobbyClearing=true";
                    if (weaponPreset) address += `&weaponPreset=${weaponPreset}`;

                    const nameColor = game.console.getBuiltInCVar("dv_name_color");
                    if (nameColor) {
                        try {
                            const finalColor = new Color(nameColor).toNumber();
                            address += `&nameColor=${finalColor}`;
                        } catch (e) {
                            game.console.setBuiltInCVar("dv_name_color", "");
                            console.error(e);
                        }
                    }

                    game.connect(address);
                    $("#splash-server-message").hide();
                } else {
                    let showWarningModal = false;
                    let title: string | undefined;
                    let message: string;
                    switch (data.message) {
                        case "rateLimit":
                            message = "Error joining game.<br>Please try again in a few minutes.";
                            break;
                        case "warning":
                            showWarningModal = true;
                            title = "Teaming is against the rules!";
                            message = "You have been reported for teaming. Allying with other players for extended periods is not allowed. If you continue to team, you will be banned.";
                            break;
                        case "tempBan":
                            showWarningModal = true;
                            title = "You have been banned for 1 day for teaming!";
                            message = "Remember, allying with other players for extended periods is not allowed!<br><br>When your ban is up, reload the page to clear this message.";
                            break;
                        case "permaBan":
                            showWarningModal = true;
                            title = "You have been permanently banned for hacking!";
                            message = "The use of scripts, plugins, extensions, etc. to modify the game in order to gain an advantage over opponents is strictly forbidden.";
                            break;
                        default:
                            message = "Error joining game.<br>Please try again in 30 seconds.";
                            break;
                    }
                    resetPlayButtons();
                    if (showWarningModal) {
                        $("#warning-modal-title").text(title ?? "");
                        $("#warning-modal-text").html(message ?? "");
                        $("#warning-modal-agree-options").toggle(data.message === "warning");
                        $("#warning-modal-agree-checkbox").prop("checked", false);
                        $("#warning-modal").show();
                        $("#btn-play-solo").addClass("btn-disabled");
                    } else {
                        $("#splash-server-message-text").html(message);
                        $("#splash-server-message").show();
                    }
                }
            }).fail(() => {
                $("#splash-server-message-text").html("Error finding game.<br>Please try again.");
                $("#splash-server-message").show();
                resetPlayButtons();
            });
        });
    };
    addPlayButtonClickHandler($("#btn-play-solo"));
    addPlayButtonClickHandler($("#btn-play-duo"));

    const params = new URLSearchParams(window.location.search);

    const nameColor = params.get("nameColor");
    if (nameColor) {
        game.console.setBuiltInCVar("dv_name_color", nameColor);
    }

    const lobbyClearing = params.get("lobbyClearing");
    if (lobbyClearing) {
        game.console.setBuiltInCVar("dv_lobby_clearing", lobbyClearing === "true");
    }

    const devPassword = params.get("password");
    if (devPassword) {
        game.console.setBuiltInCVar("dv_password", devPassword);
        location.search = "";
    }

    const roleParam = params.get("role");
    if (roleParam) {
        game.console.setBuiltInCVar("dv_role", roleParam);
        location.search = "";
    }

    const usernameField = $("#username-input");

    const youtubers = [
        {
            name: "123OP",
            link: "https://www.youtube.com/@123op."
        },
        {
            name: "TEAMFIGHTER 27",
            link: "https://www.youtube.com/@TEAMFIGHTER27"
        },
        {
            name: "NAMERIO",
            link: "https://www.youtube.com/@NAMERIO1"
        },
        {
            name: "AWMZ",
            link: "https://www.youtube.com/@AWMZ6000"
        },
        {
            name: "Ukraines dude",
            link: "https://www.youtube.com/@Ukrainesdude"
        },
        {
            name: "monet",
            link: "https://www.youtube.com/@stardust_737"
        },
        {
            name: "Tuncres",
            link: "https://www.youtube.com/@Tuncres2022"
        },
        {
            name: "silverdotware",
            link: "https://www.youtube.com/@silverdotware"
        },
        {
            name: "Pablo_Fan_",
            link: "https://www.youtube.com/@Pablo_Fan_"
        },
        {
            name: "g0dak",
            link: "https://www.youtube.com/@g0dak"
        }
    ];

    const youtuber = pickRandomInArray(youtubers);
    $("#youtube-featured-name").text(youtuber.name);
    $("#youtube-featured-content").attr("href", youtuber.link);

    const streamers = [
        {
            name: "ikou",
            link: "https://www.twitch.tv/ikou_yt"
        }
    ];

    const streamer = pickRandomInArray(streamers);
    $("#twitch-featured-name").text(streamer.name);
    $("#twitch-featured-content").attr("href", streamer.link);

    const toggleRotateMessage = (): JQuery =>
        $("#splash-rotate-message").toggle(
            window.innerWidth < window.innerHeight
        );
    toggleRotateMessage();
    $(window).on("resize", toggleRotateMessage);

    const gameMenu = $("#game-menu");
    const settingsMenu = $("#settings-menu");

    usernameField.val(game.console.getBuiltInCVar("cv_player_name"));

    usernameField.on("input", () => {
        usernameField.val(
            (usernameField.val() as string)
                // Replace fancy quotes & dashes, so they don't get stripped out
                .replace(/[\u201c\u201d\u201f]/g, '"')
                .replace(/[\u2018\u2019\u201b]/g, "'")
                .replace(/[\u2013\u2014]/g, "-")
                // Strip out non-ASCII chars
                // eslint-disable-next-line no-control-regex
                .replace(/[^\x00-\x7F]/g, "")
        );

        game.console.setBuiltInCVar("cv_player_name", usernameField.val() as string);
    });

    createDropdown("#server-select");

    const serverSelect = $<HTMLSelectElement>("#server-select");

    // Select region
    serverSelect.on("change", () => {
        // const value = serverSelect.val() as string | undefined;

        /*if (value !== undefined) {
            game.console.setBuiltInCVar("cv_region", value);
        }*/
    });

    const rulesBtn = $("#btn-rules");

    // Highlight rules & tutorial button for new players
    if (!game.console.getBuiltInCVar("cv_rules_acknowledged")) {
        rulesBtn.removeClass("btn-secondary").addClass("highlighted");
    }

    // Event listener for rules button
    rulesBtn.on("click", () => {
        game.console.setBuiltInCVar("cv_rules_acknowledged", true);
        location.href = "./rules/";
    });

    $("#btn-quit-game").on("click", () => { game.endGame(); });
    $("#btn-spectate-menu").on("click", () => { game.endGame(); });
    $("#btn-menu").on("click", () => { game.endGame(); });
    $("#btn-spectate-replay").on("click", () => { game.endGame(); $("#btn-play-solo").trigger("click"); });
    $("#btn-play-again").on("click", () => { game.endGame(); $("#btn-play-solo").trigger("click"); });

    const sendSpectatePacket = (action: SpectateActions): void => {
        const packet = new SpectatePacket();
        packet.spectateAction = action;
        game.sendPacket(packet);
    };

    $("#btn-spectate").on("click", () => {
        sendSpectatePacket(SpectateActions.BeginSpectating);
        game.spectating = true;
        game.map.indicator.setFrame("player_indicator");
    });

    $("#btn-spectate-previous").on("click", () => {
        sendSpectatePacket(SpectateActions.SpectatePrevious);
    });

    $("#btn-spectate-kill-leader").on("click", () => {
        sendSpectatePacket(SpectateActions.SpectateKillLeader);
    });

    $("#btn-report").on("click", () => {
        if (confirm(`Are you sure you want to report this player?
Players should only be reported for teaming or hacking.
Video evidence is required.`)) {
            sendSpectatePacket(SpectateActions.Report);
        }
    });
    $("#btn-spectate-next").on("click", () => {
        sendSpectatePacket(SpectateActions.SpectateNext);
    });

    $("#btn-resume-game").on("click", () => gameMenu.hide());
    $("#btn-fullscreen").on("click", () => {
        requestFullscreen();
        $("#game-menu").hide();
    });

    body.on("keydown", (e: JQuery.KeyDownEvent) => {
        if (e.key === "Escape") {
            if ($("canvas").hasClass("active") && !game.console.isOpen) {
                gameMenu.fadeToggle(250);
                settingsMenu.hide();
            }
            game.console.isOpen = false;
        }
    });

    $("#btn-settings").on("click", () => {
        $(".dialog").hide();
        settingsMenu.fadeToggle(250);
        settingsMenu.removeClass("in-game");
    });

    $("#btn-settings-game").on("click", () => {
        gameMenu.hide();
        settingsMenu.fadeToggle(250);
        settingsMenu.addClass("in-game");
    });

    $("#close-settings").on("click", () => {
        settingsMenu.fadeOut(250);
    });

    const customizeMenu = $("#customize-menu");
    $("#btn-customize").on("click", () => {
        $(".dialog").hide();
        customizeMenu.fadeToggle(250);
    });
    $("#close-customize").on("click", () => customizeMenu.fadeOut(250));

    const createTeamMenu = $("#create-team-menu");
    $("#btn-create-team").on("click", () => { createTeamMenu.fadeToggle(250); $(".dialog").hide(); });
    $("#close-create-team").on("click", () => createTeamMenu.fadeOut(250));

    $("#close-report").on("click", () => $("#report-modal").fadeOut(250));

    const role = game.console.getBuiltInCVar("dv_role");

    // Load skins
    if (!Skins.definitions.some(s => s.idString === game.console.getBuiltInCVar("cv_loadout_skin"))) {
        game.console.setBuiltInCVar("cv_loadout_skin", defaultClientCVars.cv_loadout_skin);
    }

    const updateSplashCustomize = (skinID: string): void => {
        $("#skin-base").css(
            "background-image",
            `url("./img/game/skins/${skinID}_base.svg")`
        );
        $("#skin-left-fist, #skin-right-fist").css(
            "background-image",
            `url("./img/game/skins/${skinID}_fist.svg")`
        );
    };
    updateSplashCustomize(game.console.getBuiltInCVar("cv_loadout_skin"));
    for (const skin of Skins) {
        // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
        if (skin.hideFromLoadout || (skin.roleRequired ?? role) !== role) continue;

        /* eslint-disable @typescript-eslint/restrict-template-expressions */
        // noinspection CssUnknownTarget
        const skinItem =
            $(`<div id="skin-${skin.idString}" class="skins-list-item-container">
  <div class="skins-list-item">
    <div class="skin-base" style="background-image: url('./img/game/skins/${skin.idString}_base.svg')"></div>
    <div class="skin-left-fist" style="background-image: url('./img/game/skins/${skin.idString}_fist.svg')"></div>
    <div class="skin-right-fist" style="background-image: url('./img/game/skins/${skin.idString}_fist.svg')"></div>
  </div>
  <span class="skin-name">${skin.name}</span>
</div>`);
        skinItem.on("click", function() {
            game.console.setBuiltInCVar("cv_loadout_skin", skin.idString);
            $(this).addClass("selected").siblings().removeClass("selected");
            updateSplashCustomize(skin.idString);
        });
        $("#skins-list").append(skinItem);
    }
    $(`#skin-${game.console.getBuiltInCVar("cv_loadout_skin")}`).addClass("selected");

    // Load emotes
    let selectedEmoteSlot: typeof emoteSlots[number] | undefined;
    function updateEmotesList(): void {
        const emoteList = $("#emotes-list");

        emoteList.empty();

        const noEmoteItem =
                $(`<div id="emote-none" class="emotes-list-item-container">
            <div class="emotes-list-item" style="background-image: none"></div>
        <span class="emote-name">None</span>
        </div>`);

        noEmoteItem.on("click", function() {
            if (selectedEmoteSlot === undefined) return;
            game.console.setBuiltInCVar(
                `cv_loadout_${selectedEmoteSlot}_emote`,
                ""
            );

            $(this).addClass("selected").siblings().removeClass("selected");

            $(`#emote-wheel-container .emote-${selectedEmoteSlot}`)
                .css("background-image", "none");
        });

        emoteList.append(noEmoteItem);

        for (const emote of Emotes.definitions) {
            // noinspection CssUnknownTarget
            const emoteItem =
                $(`<div id="emote-${emote.idString}" class="emotes-list-item-container">
    ${emote.idString !== "none" ? `<div class="emotes-list-item" style="background-image: url('./img/game/emotes/${emote.idString}.svg')"></div>` : ""}
    <span class="emote-name">${emote.name}</span>
    </div>`);

            emoteItem.on("click", function() {
                if (selectedEmoteSlot === undefined) return;
                game.console.setBuiltInCVar(
                    `cv_loadout_${selectedEmoteSlot}_emote`,
                    emote.idString
                );

                $(this).addClass("selected").siblings().removeClass("selected");

                $(`#emote-wheel-container .emote-${selectedEmoteSlot}`).css(
                    "background-image",
                    emote.idString !== "none" ? `url("./img/game/emotes/${emote.idString}.svg")` : "none"
                );
            });

            emoteList.append(emoteItem);
        }
    }

    updateEmotesList();
    for (const slot of emoteSlots) {
        const emote = game.console.getBuiltInCVar(`cv_loadout_${slot}_emote`);

        $(`#emote-wheel-container .emote-${slot}`)
            .css("background-image", emote ? `url("./img/game/emotes/${emote}.svg")` : "none")
            .on("click", () => {
                if (selectedEmoteSlot === slot) return;

                $(`#emote-wheel-container .emote-${selectedEmoteSlot}`)
                    .removeClass("selected");
                selectedEmoteSlot = slot;

                updateEmotesList();

                if (emoteSlots.indexOf(slot) > 3) {
                    // win / death emote
                    $("#emote-customize-wheel").css(
                        "background-image",
                        "url('/img/misc/emote_wheel.svg')"
                    );
                    $(`#emote-wheel-container .emote-${slot}`).addClass("selected");
                } else {
                    $("#emote-customize-wheel").css(
                        "background-image",
                        `url("./img/misc/emote_wheel_highlight_${slot}.svg"), url("/img/misc/emote_wheel.svg")`
                    );
                }

                $(".emotes-list-item-container")
                    .removeClass("selected")
                    .css("cursor", "pointer");
                $(`#emote-${game.console.getBuiltInCVar(`cv_loadout_${slot}_emote`) || "none"}`).addClass("selected");
            });
    }

    // Load crosshairs
    function loadCrosshair(): void {
        const size = game.console.getBuiltInCVar("cv_crosshair_size");
        const crosshair = getCrosshair(
            game.console.getBuiltInCVar("cv_loadout_crosshair"),
            game.console.getBuiltInCVar("cv_crosshair_color"),
            size,
            game.console.getBuiltInCVar("cv_crosshair_stroke_color"),
            game.console.getBuiltInCVar("cv_crosshair_stroke_size")
        );
        const cursor = crosshair === "crosshair" ? crosshair : `url("${crosshair}") ${size / 2} ${size / 2}, crosshair`;

        $("#crosshair-image").css({
            backgroundImage: `url("${crosshair}")`,
            width: size,
            height: size
        });

        $("#crosshair-controls").toggleClass("disabled", !Crosshairs[game.console.getBuiltInCVar("cv_loadout_crosshair")]);

        $("#crosshair-preview, #game").css({ cursor });
    }
    loadCrosshair();

    Crosshairs.forEach((_, crosshairIndex) => {
        const crosshairItem = $(`
    <div id="crosshair-${crosshairIndex}" class="crosshairs-list-item-container">
        <div class="crosshairs-list-item"></div>
    </div>`);

        crosshairItem.find(".crosshairs-list-item").css({
            backgroundImage: `url("${getCrosshair(
                crosshairIndex,
                "#fff",
                game.console.getBuiltInCVar("cv_crosshair_size"),
                "#0",
                0
            )}")`,
            "background-size": "contain",
            "background-repeat": "no-repeat"
        });

        crosshairItem.on("click", function() {
            game.console.setBuiltInCVar("cv_loadout_crosshair", crosshairIndex);
            loadCrosshair();
            $(this).addClass("selected").siblings().removeClass("selected");
        });

        $("#crosshairs-list").append(crosshairItem);
    });

    $(`#crosshair-${game.console.getBuiltInCVar("cv_loadout_crosshair")}`).addClass("selected");

    // Load badges
    const allowedBadges = Badges.definitions.filter(badge => badge.roles.length === 0 || badge.roles.includes(role));

    if (allowedBadges.length > 0) {
        $("#tab-badges").show();

        // ???
        /* eslint-disable @typescript-eslint/quotes, quotes */
        const noBadgeItem = $(
            `<div id="badge-" class="badges-list-item-container">\
            <div class="badges-list-item"> </div>\
            <span class="badge-name">None</span>\
            </div>`
        );

        noBadgeItem.on("click", function() {
            game.console.setBuiltInCVar("cv_loadout_badge", "");
            $(this).addClass("selected").siblings().removeClass("selected");
        });

        $("#badges-list").append(noBadgeItem);
        for (const badge of allowedBadges) {
            // noinspection CssUnknownTarget
            const badgeItem = $(
                `<div id="badge-${badge.idString}" class="badges-list-item-container">\
                <div class="badges-list-item">\
                    <div style="background-image: url('./img/game/badges/${badge.idString}.svg')"></div>\
                </div>\
                <span class="badge-name">${badge.name}</span>\
                </div>`
            );

            badgeItem.on("click", function() {
                game.console.setBuiltInCVar("cv_loadout_badge", badge.idString);
                $(this).addClass("selected").siblings().removeClass("selected");
            });

            $("#badges-list").append(badgeItem);
        }

        $(`#badge-${game.console.getBuiltInCVar("cv_loadout_badge")}`).addClass("selected");
    }

    addSliderListener("#slider-crosshair-size", "cv_crosshair_size", (value: number) => {
        game.console.setBuiltInCVar("cv_crosshair_size", 20 * value);
        loadCrosshair();
    });
    $("#slider-crosshair-size").val(game.console.getBuiltInCVar("cv_crosshair_size") / 20);

    addSliderListener("#slider-crosshair-stroke-size", "cv_crosshair_stroke_size", () => {
        loadCrosshair();
    });
    $("#slider-crosshair-stroke-size").val(game.console.getBuiltInCVar("cv_crosshair_stroke_size"));

    $<HTMLInputElement>("#crosshair-color-picker").on("input", e => {
        game.console.setBuiltInCVar("cv_crosshair_color", e.target.value);
        loadCrosshair();
    }).val(game.console.getBuiltInCVar("cv_crosshair_color"));

    $<HTMLInputElement>("#crosshair-stroke-picker").on("input", (e) => {
        game.console.setBuiltInCVar("cv_crosshair_stroke_color", e.target.value);
        loadCrosshair();
    }).val(game.console.getBuiltInCVar("cv_crosshair_stroke_color"));

    // Disable context menu
    $("#game").on("contextmenu", e => { e.preventDefault(); });

    // Load settings values and event listeners
    function addSliderListener(elementId: string, settingName: keyof CVarTypeMapping, callback?: (value: number) => void): void {
        const element = $<HTMLInputElement>(elementId)[0];
        if (!element) console.error("Invalid element id");

        element.addEventListener("input", () => {
            const value = +element.value;
            game.console.setBuiltInCVar(settingName, value);

            callback?.(value);
        });

        element.value = (game.console.getBuiltInCVar(settingName) as number).toString();
    }

    function addCheckboxListener(elementId: string, settingName: keyof CVarTypeMapping, callback?: (value: boolean) => void): void {
        const element = $<HTMLInputElement>(elementId)[0];

        element.addEventListener("input", () => {
            const value = element.checked;
            game.console.setBuiltInCVar(settingName, value);

            callback?.(value);
        });

        element.checked = game.console.getBuiltInCVar(settingName) as boolean;
    }

    // Scope looping toggle
    addCheckboxListener("#toggle-scope-looping", "cv_loop_scope_selection");

    addCheckboxListener("#toggle-anonymous-player", "cv_anonymize_player_names");

    // Music volume
    addSliderListener("#slider-music-volume", "cv_music_volume", (value: number) => {
        game.music.volume = value;
    });

    // SFX volume
    addSliderListener("#slider-sfx-volume", "cv_sfx_volume", (value: number) => {
        game.soundManager.volume = value;
    });

    // Master volume
    addSliderListener("#slider-master-volume", "cv_master_volume", (value: number) => {
        sound.volumeAll = value;
    });
    sound.volumeAll = game.console.getBuiltInCVar("cv_master_volume");

    // Old menu music
    addCheckboxListener("#toggle-old-music", "cv_use_old_menu_music");

    // Camera shake
    addCheckboxListener("#toggle-camera-shake", "cv_camera_shake_fx");

    // FPS toggle
    addCheckboxListener("#toggle-fps", "pf_show_fps", (value: boolean) => {
        $("#fps-counter").toggle(value);
    });
    $("#fps-counter").toggle(game.console.getBuiltInCVar("pf_show_fps"));

    // Ping toggle
    addCheckboxListener("#toggle-ping", "pf_show_ping", (value: boolean) => {
        $("#ping-counter").toggle(value);
    });
    $("#ping-counter").toggle(game.console.getBuiltInCVar("pf_show_ping"));

    // Coordinates toggle
    addCheckboxListener("#toggle-coordinates", "pf_show_pos", (value: boolean) => {
        $("#coordinates-hud").toggle(value);
    });
    $("#coordinates-hud").toggle(game.console.getBuiltInCVar("pf_show_pos"));

    // lmao one day, we'll have dropdown menus

    // Text killfeed toggle
    {
        const element = $<HTMLInputElement>("#toggle-text-kill-feed")[0];

        element.addEventListener("input", () => {
            game.console.setBuiltInCVar("cv_killfeed_style", element.checked ? "text" : "icon");
        });

        element.checked = game.console.getBuiltInCVar("cv_killfeed_style") === "text";
    }

    // Weapon slot style toggle
    {
        const element = $<HTMLInputElement>("#toggle-colored-slots")[0];

        element.addEventListener("input", () => {
            game.console.setBuiltInCVar("cv_weapon_slot_style", element.checked ? "colored" : "simple");
        });

        element.checked = game.console.getBuiltInCVar("cv_weapon_slot_style") === "colored";
    }

    // render mode select menu
    const renderSelect = $<HTMLSelectElement>("#render-mode-select")[0];
    renderSelect.addEventListener("input", () => {
        game.console.setBuiltInCVar("cv_renderer", renderSelect.value as unknown as "webgl1" | "webgl2" | "webgpu");
    });
    renderSelect.value = game.console.getBuiltInCVar("cv_renderer");

    void (async() => {
        $("#webgpu-option").toggle(await isWebGPUSupported());
    })();

    // render resolution select menu
    const renderResSelect = $<HTMLSelectElement>("#render-res-select")[0];
    renderResSelect.addEventListener("input", () => {
        game.console.setBuiltInCVar("cv_renderer_res", renderResSelect.value as unknown as "auto" | "0.5" | "1" | "2" | "3");
    });
    renderResSelect.value = game.console.getBuiltInCVar("cv_renderer_res");

    // High resolution toggle
    addCheckboxListener("#toggle-high-res", "cv_high_res_textures");

    // Anti-aliasing toggle
    addCheckboxListener("#toggle-antialias", "cv_antialias");

    // Movement smoothing toggle
    addCheckboxListener("#toggle-movement-smoothing", "cv_movement_smoothing");

    // Responsive rotation toggle
    addCheckboxListener("#toggle-responsive-rotation", "cv_responsive_rotation");

    // Mobile controls stuff
    addCheckboxListener("#toggle-mobile-controls", "mb_controls_enabled");
    addSliderListener("#slider-joystick-size", "mb_joystick_size");
    addSliderListener("#slider-joystick-transparency", "mb_joystick_transparency");

    const gameUi = $("#game-ui");
    function updateUiScale(): void {
        const scale = game.console.getBuiltInCVar("cv_ui_scale");

        gameUi.width(window.innerWidth / scale);
        gameUi.height(window.innerHeight / scale);
        gameUi.css("transform", `scale(${scale})`);
    }
    updateUiScale();
    window.addEventListener("resize", () => updateUiScale());

    addSliderListener("#slider-ui-scale", "cv_ui_scale", () => {
        updateUiScale();
        game.map.resize();
    });

    // TODO: fix joysticks on mobile when UI scale is not 1
    if (game.inputManager.isMobile) {
        $("#ui-scale-container").hide();
        game.console.setBuiltInCVar("cv_ui_scale", 1);
    }

    // Minimap stuff
    addSliderListener("#slider-minimap-transparency", "cv_minimap_transparency", () => {
        game.map.updateTransparency();
    });

    addSliderListener("#slider-big-map-transparency", "cv_map_transparency", () => {
        game.map.updateTransparency();
    });

    addCheckboxListener("#toggle-hide-minimap", "cv_minimap_minimized", () => {
        game.map.toggleMinimap(true);
    });

    // Leave warning
    addCheckboxListener("#toggle-leave-warning", "cv_leave_warning");

    // Blur splash screen
    addCheckboxListener("#toggle-blur-splash", "cv_blur_splash", (value: boolean) => {
        $("#splash-ui").toggleClass("blur", value);
    });

    // Hide rules button
    addCheckboxListener("#toggle-hide-rules", "cv_hide_rules_button", (value: boolean) => {
        $("#btn-rules, #rules-close-btn").toggle(!value);
    });
    rulesBtn.toggle(!game.console.getBuiltInCVar("cv_hide_rules_button"));

    // Hide option to hide rules if rules haven't been acknowledged
    $(".checkbox-setting").has("#toggle-hide-rules").toggle(game.console.getBuiltInCVar("cv_rules_acknowledged"));

    $("#rules-close-btn").on("click", () => {
        $("#btn-rules, #rules-close-btn").hide();
        game.console.setBuiltInCVar("cv_hide_rules_button", true);
        $("#toggle-hide-rules").prop("checked", true);
    }).toggle(game.console.getBuiltInCVar("cv_rules_acknowledged") && !game.console.getBuiltInCVar("cv_hide_rules_button"));

    // Import settings
    $("#import-settings-btn").on("click", () => {
        if (!confirm("This option will overwrite all settings and reload the page. Continue?")) return;
        const error = (): void => {
            alert("Invalid config.");
        };
        try {
            const input = prompt("Enter a config:");
            if (!input) {
                error();
                return;
            }

            const config = JSON.parse(input);
            if (typeof config !== "object" || !("variables" in config)) {
                error();
                return;
            }

            localStorage.setItem("suroi_config", input);
            alert("Settings loaded successfully.");
            window.location.reload();
        } catch (e) {
            error();
        }
    });

    // Copy settings to clipboard
    $("#export-settings-btn").on("click", () => {
        const exportedSettings = localStorage.getItem("suroi_config");
        const error = (): void => {
            alert('Unable to copy settings. To export settings manually, open the dev tools with Ctrl+Shift+I and type in the following: localStorage.getItem("suroi_config")');
        };
        if (exportedSettings === null) {
            error();
            return;
        }
        navigator.clipboard
            .writeText(exportedSettings)
            .then(() => {
                alert("Settings copied to clipboard.");
            })
            .catch(error);
    });

    // Reset settings
    $("#reset-settings-btn").on("click", () => {
        if (!confirm("This option will reset all settings and reload the page. Continue?")) return;
        if (!confirm("Are you sure? This action cannot be undone.")) return;
        localStorage.removeItem("suroi_config");
        window.location.reload();
    });

    // Switch weapon slots by clicking
    const maxWeapons = GameConstants.player.maxWeapons;
    for (let slot = 0; slot < maxWeapons; slot++) {
        const slotElement = $(`#weapon-slot-${slot + 1}`);
        slotElement[0].addEventListener(
            "pointerdown",
            (e: PointerEvent): void => {
                if (slotElement.hasClass("has-item")) {
                    e.stopImmediatePropagation();
                    if (slot === 3) { // Check if the slot is 4 (0-indexed)
                        const step = 1; // Define the step for cycling
                        if (game.activePlayer?.activeItem.itemType === ItemType.Throwable) game.inputManager.cycleThrowable(step);
                    }
                    game.inputManager.addAction({
                        type: e.button === 2 ? InputActions.DropWeapon : InputActions.EquipItem,
                        slot
                    });
                }
            }
        );
    }

    // Generate the UI for scopes, healing items and ammos
    for (const scope of Scopes) {
        $("#scopes-container").append(`
        <div class="inventory-slot item-slot" id="${scope.idString}-slot" style="display: none;">
            <img class="item-image" src="./img/game/loot/${scope.idString}.svg" draggable="false">
            <div class="item-tooltip">${scope.name.split(" ")[0]}</div>
        </div>`);

        dropItemListener(game, $(`#${scope.idString}-slot`), scope);

        $(`#${scope.idString}-slot`)[0].addEventListener(
            "pointerdown",
            (e: PointerEvent): void => {
                e.stopImmediatePropagation();
                if (e.button === 2) {
                    game.inputManager.addAction({
                        type: InputActions.DropItem,
                        item: scope
                    });
                } else {
                    game.inputManager.addAction({
                        type: InputActions.UseItem,
                        item: scope
                    });
                }
            }
        );

        if (UI_DEBUG_MODE) {
            $(`#${scope.idString}-slot`).show();
        }
    }

    for (const item of HealingItems) {
        $("#healing-items-container").append(`
        <div class="inventory-slot item-slot" id="${item.idString}-slot">
            <img class="item-image" src="./img/game/loot/${item.idString}.svg" draggable="false">
            <span class="item-count" id="${item.idString}-count">0</span>
            <div class="item-tooltip">
                ${item.name}
                <br>
                Restores ${item.restoreAmount}${item.healType === HealType.Adrenaline ? "% adrenaline" : " health"}
            </div>
        </div>`);

        $(`#${item.idString}-slot`)[0].addEventListener("pointerdown", (e: PointerEvent) => {
            game.inputManager.addAction({
                type: InputActions.UseItem,
                item
            });
            e.stopPropagation();
        });
        dropItemListener(game, $(`#${item.idString}-slot`), item);
    }

    for (const ammo of Ammos) {
        if (ammo.ephemeral) continue;

        $(`#${ammo.hideUnlessPresent ? "special-" : ""}ammo-container`).append(`
        <div class="inventory-slot item-slot ammo-slot" id="${ammo.idString}-slot">
            <img class="item-image" src="./img/game/loot/${ammo.idString}.svg" draggable="false">
            <span class="item-count" id="${ammo.idString}-count">0</span>
        </div>`);

        dropItemListener(game, $(`#${ammo.idString}-slot`), ammo);
    }

    for (const armor of ["helmet", "vest"]) {
        const armorContainer = $(`#${armor}-slot`);

        armorContainer[0].addEventListener(
            "pointerdown",
            (e: PointerEvent): void => {
                e.stopImmediatePropagation();
                if (e.button === 2 && game.activePlayer) {
                    game.inputManager.addAction({
                        type: InputActions.DropItem,
                        item: game.activePlayer.getEquipment(armor)
                    });
                }
            }
        );
    }

    const backpackContainer = $("#backpack-slot");

    backpackContainer[0].addEventListener(
        "pointerdown",
        (e: PointerEvent): void => {
            e.stopImmediatePropagation();
            if (e.button === 2 && game.activePlayer) {
                game.inputManager.addAction({
                    type: InputActions.DropItem,
                    item: game.activePlayer.getEquipment("backpack")
                });
            }
        }
    );

    // Hide mobile settings on desktop
    $("#tab-mobile").toggle(isMobile.any);

    // Mobile event listeners
    if (game.inputManager.isMobile) {
        // Interact message
        $("#interact-message").on("click", () => {
            game.console.handleQuery(game.uiManager.action.active ? "cancel_action" : "interact");
        });
        // noinspection HtmlUnknownTarget
        $("#interact-key").html('<img src="./img/misc/tap-icon.svg" alt="Tap">');

        // Reload button
        $("#btn-reload")
            .show()
            .on("click", () => {
                game.console.handleQuery("reload");
            });

        // Emote button & wheel
        $("#emote-wheel")
            .css("top", "50%")
            .css("left", "50%");
        $("#btn-emotes").show().on("click", () => {
            $("#emote-wheel").show();
        });

        const createEmoteWheelListener = (slot: string, action: InputActions): void => {
            $(`#emote-wheel .emote-${slot}`).on("click", () => {
                $("#emote-wheel").hide();
                game.inputManager.addAction(action);
            });
        };
        createEmoteWheelListener("top", InputActions.TopEmoteSlot);
        createEmoteWheelListener("right", InputActions.RightEmoteSlot);
        createEmoteWheelListener("bottom", InputActions.BottomEmoteSlot);
        createEmoteWheelListener("left", InputActions.LeftEmoteSlot);

        // Game menu
        $("#btn-game-menu")
            .show()
            .on("click", () => {
                $("#game-menu").toggle();
            });
    }

    // Prompt when trying to close the tab while playing
    window.addEventListener("beforeunload", (e: Event) => {
        if ($("canvas").hasClass("active") && game.console.getBuiltInCVar("cv_leave_warning") && !game.gameOver) {
            e.preventDefault();
        }
    });

    // Hack to style range inputs background and add a label with the value :)
    function updateRangeInput(element: HTMLInputElement): void {
        const value = +element.value;
        const max = +element.max;
        const min = +element.min;
        const x = ((value - min) / (max - min)) * 100;
        $(element).css(
            "--background",
            `linear-gradient(to right, #ff7500 0%, #ff7500 ${x}%, #f8f9fa ${x}%, #f8f9fa 100%)`
        );
        $(element)
            .siblings(".range-input-value")
            .text(
                element.id !== "slider-joystick-size"
                    ? `${Math.round(value * 100)}%`
                    : value
            );
    }

    $<HTMLInputElement>("input[type=range]")
        .on("input", e => {
            updateRangeInput(e.target);
        })
        .each((_i, element) => {
            updateRangeInput(element);
        });

    $(".tab").on("click", (ev) => {
        const tab = $(ev.target);

        tab.siblings().removeClass("active");

        tab.addClass("active");

        const tabContent = $(`#${ev.target.id}-content`);

        tabContent.siblings().removeClass("active");
        tabContent.siblings().hide();

        tabContent.addClass("active");
        tabContent.show();
    });

    $("#warning-modal-agree-checkbox").on("click", function() {
        $("#warning-btn-play-solo, #btn-play-solo").toggleClass("btn-disabled", !$(this).prop("checked"));
    });
    $("#warning-btn-play-solo").on("click", () => {
        $("#warning-modal").hide();
        $("#btn-play-solo").trigger("click");
    });
}
