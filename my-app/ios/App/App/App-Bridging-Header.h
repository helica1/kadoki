// Kadoki bridging header. kadoki_remux is implemented only in the visionOS
// static lib (App/Remux/libkadokiremux-xros.a); Swift call sites are gated
// #if os(visionOS), so the declaration is harmless on iOS.
#import "kadoki_remux.h"

// Sonic (Bill Cox, Apache 2.0): pitch-synchronous speech time-stretch for the
// read-mode engine (KadokiReadEngine.swift).
#import "speedy/sonic2.h"   /* Speedy shim over Sonic: sonicCreateStream etc. + sonicEnableNonlinearSpeedup */
