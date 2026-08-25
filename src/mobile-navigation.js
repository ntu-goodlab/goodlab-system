/**
 * 將帳號可使用的頁面分配到手機底部導覽與「更多」抽屜。
 * 五個以內全部顯示；超過五個時保留四個主要入口，剩餘功能收進抽屜。
 */
export function getMobileNavigationLayout(
    allowedIds,
    {
        maxVisibleItems = 5,
        primaryItemCount = 4,
        priorityIds = []
    } = {}
) {
    const uniqueAllowedIds = [...new Set(allowedIds.filter(Boolean))];
    const allowedSet = new Set(uniqueAllowedIds);
    const orderedIds = [
        ...priorityIds.filter(id => allowedSet.has(id)),
        ...uniqueAllowedIds.filter(id => !priorityIds.includes(id))
    ];

    if (orderedIds.length <= maxVisibleItems) {
        return {
            directIds: orderedIds,
            overflowIds: [],
            showMore: false
        };
    }

    const directCount = Math.min(primaryItemCount, maxVisibleItems - 1);
    return {
        directIds: orderedIds.slice(0, directCount),
        overflowIds: orderedIds.slice(directCount),
        showMore: true
    };
}
