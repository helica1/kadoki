#import "KadokiHinge.h"

BOOL KadokiInstallHingeObserver(UIView *view, void (^handler)(NSInteger status, double angle)) {
#if defined(__IPHONE_27_1) && __IPHONE_OS_VERSION_MAX_ALLOWED >= __IPHONE_27_1
    if (@available(iOS 27.1, visionOS 27.1, *)) {
        UIHingeInteraction *hi = [[UIHingeInteraction alloc] initWithUpdateHandler:^(UIHingeInteraction *interaction, UIHingeInteractionUpdate *update) {
            UIHinge *hinge = update.hinge;
            if (!hinge) { handler(-1, 0); return; }
            handler((NSInteger)hinge.status, (double)hinge.angle);
        }];
        [view addInteraction:hi];
        return YES;
    }
#endif
    return NO;
}
