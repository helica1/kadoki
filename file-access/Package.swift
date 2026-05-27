// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "FileAccess",
    platforms: [.iOS(.v14)],
    products: [
        .library(
            name: "FileAccess",
            targets: ["FileAccessPluginPlugin"])
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", from: "7.0.0")
    ],
    targets: [
        .target(
            name: "FileAccessPluginPlugin",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm")
            ],
            path: "ios/Sources/FileAccessPluginPlugin"),
        .testTarget(
            name: "FileAccessPluginPluginTests",
            dependencies: ["FileAccessPluginPlugin"],
            path: "ios/Tests/FileAccessPluginPluginTests")
    ]
)