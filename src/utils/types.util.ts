export type TResponse = {
    data: TGenResObj;
    code: number;
}

export type TGenResObj = {
    success: boolean;
    message: string;
    data?: any;
};