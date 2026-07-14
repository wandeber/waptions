import { describe, expect, it } from 'vitest';
import {
    beginContinuousEdit,
    getContinuousEditKeyboardTerminal,
    previewContinuousEdit,
    terminateContinuousEdit,
} from './continuous-edit-session';

describe('continuous edit sessions', () => {
    it('does not terminate Enter or Escape while an IME composition owns the key', () => {
        expect(getContinuousEditKeyboardTerminal('Enter', true)).toBeNull();
        expect(getContinuousEditKeyboardTerminal('Escape', true)).toBeNull();
        expect(getContinuousEditKeyboardTerminal('Enter', false)).toBe('commit');
        expect(getContinuousEditKeyboardTerminal('Escape', false)).toBe('cancel');
    });

    it('keeps a durable baseline and the latest local preview', () => {
        const session = previewContinuousEdit(
            previewContinuousEdit(beginContinuousEdit(10), 11),
            15,
        );

        expect(session).toEqual({ baseline: 10, latest: 15, terminal: null });
        expect(terminateContinuousEdit(session, 'commit')).toMatchObject({
            value: 15,
            shouldCommit: true,
            session: { terminal: 'commit' },
        });
    });

    it('turns an unchanged commit into a no-op and restores the baseline on cancel', () => {
        expect(terminateContinuousEdit(beginContinuousEdit('same'), 'commit')).toMatchObject({
            value: 'same',
            shouldCommit: false,
        });
        expect(terminateContinuousEdit(
            previewContinuousEdit(beginContinuousEdit('before'), 'draft'),
            'cancel',
        )).toMatchObject({ value: 'before', shouldCommit: false });
    });

    it('makes every terminal path idempotent', () => {
        const first = terminateContinuousEdit(
            previewContinuousEdit(beginContinuousEdit(1), 2),
            'commit',
        );
        const repeatedCommit = terminateContinuousEdit(first.session, 'commit');
        const lateCancel = terminateContinuousEdit(first.session, 'cancel');

        expect(repeatedCommit.shouldCommit).toBe(false);
        expect(lateCancel.shouldCommit).toBe(false);
        expect(repeatedCommit.session).toBe(first.session);
        expect(lateCancel.session).toBe(first.session);
        expect(previewContinuousEdit(first.session, 3)).toBe(first.session);
    });

    it('retains the original durable baseline when reset replaces an active draft', () => {
        const typedDraft = previewContinuousEdit(beginContinuousEdit(6), 0);
        const resetDraft = previewContinuousEdit(typedDraft, 0);
        const committedReset = terminateContinuousEdit(resetDraft, 'commit');

        expect(committedReset).toMatchObject({
            value: 0,
            shouldCommit: true,
            session: { baseline: 6, latest: 0, terminal: 'commit' },
        });
        expect(terminateContinuousEdit(committedReset.session, 'commit').shouldCommit).toBe(false);
        expect(terminateContinuousEdit(committedReset.session, 'cancel').shouldCommit).toBe(false);
    });
});
