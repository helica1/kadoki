// Foldable iPhone (iPhone Duo) hinge observer.
//
// Objective-C rather than Swift so the project still builds with an SDK that
// predates UIHingeInteraction (iOS 27.1): the whole body compiles away when
// the SDK is older, and the API is availability-checked at runtime.
#import <UIKit/UIKit.h>

NS_ASSUME_NONNULL_BEGIN

/// Adds a UIHingeInteraction to `view`. `handler(status, angle)` runs on the
/// main thread with the initial state and on every change: status is
/// UIHingeStatus (0 unknown, 1 closed, 2 partially open, 3 fully open), or -1
/// when the view left a hierarchy that has a hinge. Returns NO when the SDK or
/// the OS has no hinge API; the handler is then never called.
BOOL KadokiInstallHingeObserver(UIView *view, void (^handler)(NSInteger status, double angle));

NS_ASSUME_NONNULL_END
