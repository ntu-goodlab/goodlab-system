// Compare editable values and row structure, ignoring focus and presentation state.
export function employmentEditFingerprint(container) {
    if (!container) return null;
    const editors = [...container.querySelectorAll('[data-draft-key]')];
    if (!editors.length) return null;
    return JSON.stringify(editors.map(editor => ({
        key: editor.dataset.draftKey,
        fields: [...editor.querySelectorAll('input[id], textarea[id], select[id]')]
            .filter(field => field.id !== 'employment-person-student')
            .map(field => [field.id, field.type === 'checkbox' || field.type === 'radio' ? field.checked : field.value])
    })));
}
