// Type definitions for democracy
// Project: https://github.com/goldfire/democracy.js
// Definitions by: Bryce Deneen <https://github.com/redbricksoftware>
// Definitions: https://github.com/DefinitelyTyped/DefinitelyTyped

declare interface DemocracyJS {
    constructor(opts?: any);
    nodes(): any;
    leader(): any;
    resign(): any;
    isLeader(): boolean;
    send(customEvent: Object, extraData: Object): any;
    on(event: string, func: (data: any) => void);
}

declare const democracy: DemocracyJS;
export = democracy;
