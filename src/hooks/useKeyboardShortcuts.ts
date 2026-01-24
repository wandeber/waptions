import { useEffect } from 'react';
import { SHORTCUTS } from '@/config/shortcuts';

type ShortcutHandlers = {
    [K in keyof typeof SHORTCUTS]?: (e: KeyboardEvent) => void;
};

export function useKeyboardShortcuts(handlers: ShortcutHandlers) {
    useEffect(() => {
        const handleKeyDown = (event: KeyboardEvent) => {
            // Don't trigger shortcuts when typing in inputs
            const target = event.target as HTMLElement;
            if (
                target.tagName === 'INPUT' ||
                target.tagName === 'TEXTAREA' ||
                target.isContentEditable
            ) {
                return;
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
