// Preserve only matching editors; never carry a draft into another record or account.
export function captureFormDrafts(container) {
    if (!container) return [];
    return [...container.querySelectorAll('[data-draft-key]')].map(editor => ({
        key: editor.dataset.draftKey,
        fields: [...editor.querySelectorAll('input[id], textarea[id], select[id]')].map(field => ({
            id: field.id, value: field.value, checked: field.checked,
            disabled: field.disabled, focused: field === document.activeElement,
            start: field.selectionStart, end: field.selectionEnd
        }))
    }));
}

export function restoreFormDrafts(container, drafts) {
    for (const draft of drafts) {
        const editor = [...container.querySelectorAll('[data-draft-key]')].find(item => item.dataset.draftKey === draft.key);
        if (!editor) continue;
        for (const state of draft.fields) {
            const field = [...editor.querySelectorAll('input[id], textarea[id], select[id]')].find(item => item.id === state.id);
            if (!field || field.disabled) continue;
            field.value = state.value;
            if (field.type === 'checkbox' || field.type === 'radio') field.checked = state.checked;
            if (state.focused) {
                field.focus({ preventScroll: true });
                if (typeof state.start === 'number' && field.setSelectionRange) field.setSelectionRange(state.start, state.end);
            }
        }
    }
}
