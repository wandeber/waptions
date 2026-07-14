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
        description: 'Guardar cambios',
        category: 'system'
    },
    UNDO: {
        id: 'UNDO',
        key: 'z',
        ctrlOrMeta: true,
        description: 'Deshacer',
        category: 'edit'
    },
    REDO: {
        id: 'REDO',
        key: 'z',
        ctrlOrMeta: true,
        shift: true,
        description: 'Rehacer',
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
        description: 'Copiar selección',
        category: 'edit'
    },
    PASTE: {
        id: 'PASTE',
        key: 'v',
        ctrlOrMeta: true,
        description: 'Pegar selección',
        category: 'edit'
    },
    TRIM_START: {
        id: 'TRIM_START',
        key: 'q',
        description: 'Recortar al inicio',
        category: 'edit'
    },
    TRIM_END: {
        id: 'TRIM_END',
        key: 'w',
        description: 'Recortar al final',
        category: 'edit'
    },
    DELETE: {
        id: 'DELETE',
        key: 'Backspace',
        description: 'Eliminar selección',
        category: 'edit'
    },
    PLAY_PAUSE: {
        id: 'PLAY_PAUSE',
        key: ' ',
        description: 'Reproducir / Pausa',
        category: 'navigation'
    },
    EDIT_SUBTITLE: {
        id: 'EDIT_SUBTITLE',
        key: 'Enter',
        description: 'Editar subtítulo bajo cabezal',
        category: 'edit'
    },
    SELECT_SUBTITLE: {
        id: 'SELECT_SUBTITLE',
        key: 'v',
        description: 'Seleccionar subtítulo bajo cabezal',
        category: 'edit'
    }
};
