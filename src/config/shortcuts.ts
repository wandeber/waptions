export interface ShortcutConfig {
    id: string;
    key: string; // e.g., 's', 'z', 'q'
    ctrlOrMeta?: boolean;
    shift?: boolean;
    alt?: boolean;
    description: string;
    category: 'edit' | 'navigation' | 'system';
}

export const SHORTCUTS: Record<string, ShortcutConfig> = {
    SAVE: {
        id: 'SAVE',
        key: 's',
        ctrlOrMeta: true,
        description: 'Save changes',
        category: 'system'
    },
    UNDO: {
        id: 'UNDO',
        key: 'z',
        ctrlOrMeta: true,
        description: 'Undo',
        category: 'edit'
    },
    REDO: {
        id: 'REDO',
        key: 'z',
        ctrlOrMeta: true,
        shift: true,
        description: 'Redo',
        category: 'edit'
    },
    REDO_Y: {
        id: 'REDO_Y',
        key: 'y',
        ctrlOrMeta: true,
        description: 'Redo',
        category: 'edit'
    },
    COPY: {
        id: 'COPY',
        key: 'c',
        ctrlOrMeta: true,
        description: 'Copy selection',
        category: 'edit'
    },
    PASTE: {
        id: 'PASTE',
        key: 'v',
        ctrlOrMeta: true,
        description: 'Paste selection',
        category: 'edit'
    },
    TRIM_START: {
        id: 'TRIM_START',
        key: 'q',
        description: 'Trim selection start',
        category: 'edit'
    },
    TRIM_END: {
        id: 'TRIM_END',
        key: 'w',
        description: 'Trim selection end',
        category: 'edit'
    },
    DELETE: {
        id: 'DELETE',
        key: 'Backspace',
        description: 'Delete selected media',
        category: 'edit'
    },
    PLAY_PAUSE: {
        id: 'PLAY_PAUSE',
        key: ' ',
        description: 'Play or pause',
        category: 'navigation'
    },
    EDIT_SUBTITLE: {
        id: 'EDIT_SUBTITLE',
        key: 'Enter',
        description: 'Edit subtitle at playhead',
        category: 'edit'
    },
    SELECT_SUBTITLE: {
        id: 'SELECT_SUBTITLE',
        key: 'v',
        description: 'Select subtitle at playhead',
        category: 'edit'
    },
    PREVIOUS_FRAME: {
        id: 'PREVIOUS_FRAME',
        key: 'ArrowLeft',
        description: 'Previous frame',
        category: 'navigation'
    },
    NEXT_FRAME: {
        id: 'NEXT_FRAME',
        key: 'ArrowRight',
        description: 'Next frame',
        category: 'navigation'
    }
};

export type ShortcutId = keyof typeof SHORTCUTS;

const DISPLAY_KEYS: Record<string, string> = {
    ' ': 'Space',
    ArrowLeft: 'Left Arrow',
    ArrowRight: 'Right Arrow',
    Backspace: 'Backspace',
};

/** Formats one shortcut consistently for native hover tooltips across editor controls. */
export function formatShortcut(shortcutId: ShortcutId): string {
    const shortcut = SHORTCUTS[shortcutId];
    return [
        shortcut.ctrlOrMeta ? 'Ctrl/Cmd' : null,
        shortcut.shift ? 'Shift' : null,
        shortcut.alt ? 'Alt' : null,
        DISPLAY_KEYS[shortcut.key] ?? shortcut.key.toUpperCase(),
    ].filter(Boolean).join('+');
}

export function formatShortcutTitle(label: string, shortcutId: ShortcutId): string {
    return `${label} (${formatShortcut(shortcutId)})`;
}

/** WAI-ARIA uses full modifier names and space-separated alternatives. */
export function getShortcutAriaKeys(shortcutId: ShortcutId): string {
    const shortcut = SHORTCUTS[shortcutId];
    const key = shortcut.key === ' ' ? 'Space' : shortcut.key;
    const suffix = [shortcut.shift ? 'Shift' : null, shortcut.alt ? 'Alt' : null, key]
        .filter(Boolean)
        .join('+');
    return shortcut.ctrlOrMeta ? `Control+${suffix} Meta+${suffix}` : suffix;
}
