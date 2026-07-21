#import <AppKit/AppKit.h>
#import <Foundation/Foundation.h>

typedef void (*DropCallback)(const char *);
typedef void (*ClickCallback)(void);
typedef void (*MenuCallback)(const char *);

@interface SoniqTrayView : NSView <NSDraggingDestination>
@property(nonatomic, assign) DropCallback callback;
@property(nonatomic, assign) ClickCallback clickCallback;
@property(nonatomic, assign) MenuCallback menuCallback;
- (void)onMenuScan:(id)sender;
- (void)onMenuLibrary:(id)sender;
- (void)onMenuQuit:(id)sender;
@end

@implementation SoniqTrayView

- (instancetype)initWithFrame:(NSRect)frameRect {
  self = [super initWithFrame:frameRect];
  if (self) {
    [self registerForDraggedTypes:@[ NSPasteboardTypeFileURL ]];
  }
  return self;
}

- (NSDragOperation)draggingEntered:(id<NSDraggingInfo>)sender {
  NSPasteboard *pboard = [sender draggingPasteboard];
  if ([[pboard types] containsObject:NSPasteboardTypeFileURL]) {
    return NSDragOperationCopy;
  }
  return NSDragOperationNone;
}

- (BOOL)performDragOperation:(id<NSDraggingInfo>)sender {
  NSPasteboard *pboard = [sender draggingPasteboard];
  if ([[pboard types] containsObject:NSPasteboardTypeFileURL]) {
    NSArray *urls = [pboard readObjectsForClasses:@[ [NSURL class] ]
                                          options:nil];
    for (NSURL *url in urls) {
      if (self.callback && url.path) {
        self.callback([url.path UTF8String]);
        return YES;
      }
    }
  }
  return NO;
}

- (void)mouseDown:(NSEvent *)event {
  [NSApp activateIgnoringOtherApps:YES];
  if (self.clickCallback) {
    self.clickCallback();
  }
  
  if ([self.superview isKindOfClass:[NSStatusBarButton class]]) {
    NSStatusBarButton *btn = (NSStatusBarButton *)self.superview;
    [btn highlight:YES];
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.15 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
      [btn highlight:NO];
    });
  }
}

- (void)rightMouseDown:(NSEvent *)event {
  [NSApp activateIgnoringOtherApps:YES];
  
  NSMenu *menu = [[NSMenu alloc] initWithTitle:@"SonIQ"];
  
  NSMenuItem *scanItem = [[NSMenuItem alloc] initWithTitle:@"Scan New Video..." action:@selector(onMenuScan:) keyEquivalent:@""];
  scanItem.target = self;
  [menu addItem:scanItem];
  
  NSMenuItem *libItem = [[NSMenuItem alloc] initWithTitle:@"Open Library" action:@selector(onMenuLibrary:) keyEquivalent:@""];
  libItem.target = self;
  [menu addItem:libItem];
  
  [menu addItem:[NSMenuItem separatorItem]];
  
  NSMenuItem *quitItem = [[NSMenuItem alloc] initWithTitle:@"Quit SonIQ" action:@selector(onMenuQuit:) keyEquivalent:@"q"];
  quitItem.target = self;
  [menu addItem:quitItem];
  
  [NSMenu popUpContextMenu:menu withEvent:event forView:self];
}

- (void)onMenuScan:(id)sender {
  if (self.menuCallback) self.menuCallback("scan_video");
}

- (void)onMenuLibrary:(id)sender {
  if (self.menuCallback) self.menuCallback("open_library");
}

- (void)onMenuQuit:(id)sender {
  if (self.menuCallback) self.menuCallback("quit");
}

@end

static NSStatusItem *globalItem = nil;

void setup_mac_tray(DropCallback drop_callback, ClickCallback click_callback, MenuCallback menu_callback) {
  dispatch_async(dispatch_get_main_queue(), ^{
    globalItem = [[NSStatusBar systemStatusBar]
        statusItemWithLength:NSSquareStatusItemLength];

    NSStatusBarButton *button = globalItem.button;
    if (button) {
      NSImage *img = [NSImage imageNamed:@"TrayIconTemplate"];
      if (img) {
        button.image = img;
      } else if (@available(macOS 11.0, *)) {
        NSImage *sysImg = [NSImage imageWithSystemSymbolName:@"waveform.circle"
                                 accessibilityDescription:@"SonIQ"];
        [sysImg setTemplate:YES];
        button.image = sysImg;
      }

      SoniqTrayView *trayView =
          [[SoniqTrayView alloc] initWithFrame:button.bounds];
      trayView.callback = drop_callback;
      trayView.clickCallback = click_callback;
      trayView.menuCallback = menu_callback;
      [trayView setAutoresizingMask:NSViewWidthSizable | NSViewHeightSizable];
      [button addSubview:trayView];

      [button.window registerForDraggedTypes:@[ NSPasteboardTypeFileURL ]];
    }
  });
}
