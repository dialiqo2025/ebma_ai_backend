export const GenResObj = (code: number, success: boolean, message: string, data?: any) =>
    ({ code, data: { success, message, data } });