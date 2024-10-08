export type ColorKeys = "grass" | "water" | "border" | "beach" | "riverBank" | "gas" | "void";

export interface ModeDefinition {
    readonly idString: string
    readonly colors: Record<ColorKeys, string>
    readonly specialMenuMusic?: boolean
    readonly reskin?: string
    // will be multiplied by the bullet trail color
    readonly bulletTrailAdjust?: string
}

export interface ReskinDefinition {
    readonly sounds?: string[]
}

export const Modes: readonly ModeDefinition[] = [
    {
        idString: "normal",
        colors: {
            grass: "hsl(113, 42%, 42%)",
            water: "hsl(211, 63%, 42%)",
            border: "hsl(211, 63%, 30%)",
            beach: "hsl(40, 39%, 55%)",
            riverBank: "hsl(33, 50%, 30%)",
            gas: "hsla(17, 100%, 50%, 0.55)",
            void: "hsl(25, 80%, 6%)"
        }
    },
    {
        idString: "halloween",
        colors: {
            grass: "hsl(65, 100%, 12%)",
            water: "hsl(4, 100%, 14%)",
            border: "hsl(4, 90%, 12%)",
            beach: "hsl(33, 77%, 21%)",
            riverBank: "hsl(33, 50%, 30%)",
            gas: "hsla(17, 100%, 50%, 0.55)",
            void: "hsl(25, 80%, 6%)"
        },
        specialMenuMusic: true,
        reskin: "fall"
    },
    {
        idString: "fall",
        colors: {
            grass: "hsl(113, 42%, 42%)",
            water: "hsl(211, 63%, 42%)",
            border: "hsl(211, 63%, 30%)",
            beach: "hsl(40, 39%, 55%)",
            riverBank: "hsl(33, 50%, 30%)",
            gas: "hsla(17, 100%, 50%, 0.55)",
            void: "hsl(25, 80%, 6%)"
        },
        reskin: "fall"
    },
    {
        idString: "winter",
        colors: {
            grass: "hsl(210, 18%, 82%)",
            water: "hsl(211, 63%, 42%)",
            border: "hsl(208, 94%, 45%)",
            beach: "hsl(210, 18%, 75%)",
            riverBank: "hsl(210, 18%, 70%)",
            gas: "hsla(17, 100%, 50%, 0.55)",
            void: "hsl(25, 80%, 6%)"
        },
        specialMenuMusic: true,
        reskin: "winter",
        bulletTrailAdjust: "hsl(0, 50%, 80%)"
    }
];

export const Reskins: Record<string, ReskinDefinition> = {
    winter: {
        sounds: [
            "airdrop_plane"
        ]
    }
};

/*
    equivalent to [...new Set(whatever)], but is faster and also becomes
    even faster when duplicates are present (yes this was benchmarked)
*/
export const ModeAtlases = Modes
    .map(mode => mode.reskin)
    .filter(reskin => reskin !== undefined)
    .filter((item, index, array) => array.indexOf(item) === index);
