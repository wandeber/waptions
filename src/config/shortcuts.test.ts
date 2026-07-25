import { describe, expect, it } from 'vitest';
import { formatShortcut, formatShortcutTitle, getShortcutAriaKeys } from './shortcuts';

describe('shortcut presentation', () => {
    it('formats display tooltips and aria alternatives from the same source', () => {
        expect(formatShortcut('REDO')).toBe('Ctrl/Cmd+Shift+Z');
        expect(formatShortcutTitle('Play', 'PLAY_PAUSE')).toBe('Play (Space)');
        expect(formatShortcut('PREVIOUS_FRAME')).toBe('Left Arrow');
        expect(getShortcutAriaKeys('SAVE')).toBe('Control+s Meta+s');
        expect(formatShortcut('TEXT_SPLIT_BLOCK')).toBe('Shift+S');
        expect(formatShortcutTitle('Delete silences', 'TEXT_DELETE_ALL_SILENCES'))
            .toBe('Delete silences (Shift+Delete)');
        expect(getShortcutAriaKeys('TEXT_DELETE_SELECTION')).toBe('Delete');
    });
});
