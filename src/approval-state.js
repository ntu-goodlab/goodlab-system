// A retained Google binding is identity evidence to review, never authorization.
export function approvalState(member, request) {
    if (!member) return { blocked: true, label: '查無成員，請先建立成員資料' };
    if (member.Google_UID && member.Google_UID !== request._id) {
        return { blocked: true, label: '綁定其他 Google 帳號，請先解除原綁定' };
    }
    if (member.Google_UID && member.Google_Email && member.Google_Email !== request.email) {
        return { blocked: true, label: '綁定信箱不一致，請先核對並解除原綁定' };
    }
    if (!['Active', 'Alumni'].includes(member.Status)) return { blocked: true, label: '成員狀態不正確，請先修正' };
    const reactivate = member.Status === 'Alumni';
    return { blocked: false, reactivate, label: reactivate ? '核對並恢復使用權限'
        : member.Google_UID ? '核對舊綁定並開通' : '核對並開通' };
}
