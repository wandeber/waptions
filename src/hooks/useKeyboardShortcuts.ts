import { useEffect } from 'react';
import { SHORTCUTS } from '@/config/shortcuts';
import { isTextEditingKeyboardTarget } from '@/lib/keyboard-target';

type ShortcutHandlers = {
    [K in keyof typeof SHORTCUTS]?: (e: KeyboardEvent) => void;
};

const NATIVE_ACTIVATION_TARGETS = [
    'button',
    'a[href]',
    'area[href]',
    'summary',
    'audio[controls]',
    'video[controls]',
    '[role="button"]',
].join(',');

export function useKeyboardShortcuts(handlers: ShortcutHandlers) {
    useEffect(() => {
        const handleKeyDown = (event: KeyboardEvent) => {
            const target = event.target;
            // Editing controls own every keystroke, including the controlled textarea's dedicated
            // app-history implementation.
            if (isTextEditingKeyboardTarget(target)) return;
            if (target instanceof Element) {
                // Activation controls only own unmodified Enter and Space; editor commands such as
                // Ctrl/Cmd+S and Undo must still work after a toolbar button retains focus.
                const isUnmodifiedActivationKey = (
                    event.key === ' '
                    || event.key === 'Enter'
                ) && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey;
                if (isUnmodifiedActivationKey && target.closest(NATIVE_ACTIVATION_TARGETS)) return;
            }

            for (const [id, config] of Object.entries(SHORTCUTS)) {
                const handler = handlers[id as keyof ShortcutHandlers];
                if (!handler) continue;

                const isShift = config.shift ? event.shiftKey : !event.shiftKey;
                const isAlt = config.alt ? event.altKey : !event.altKey;

                // If the config doesn't specify ctrlOrMeta, we ensure it's NOT pressed
                const ctrlMatch = config.ctrlOrMeta
                    ? (event.ctrlKey || event.metaKey)
                    : (!event.ctrlKey && !event.metaKey);

                if (
                    event.key.toLowerCase() === config.key.toLowerCase() &&
                    ctrlMatch &&
                    isShift &&
                    isAlt
                ) {
                    event.preventDefault();
                    handler(event);
                    break;
                }
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [handlers]);
}
