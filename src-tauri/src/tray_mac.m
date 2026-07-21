#import <AppKit/AppKit.h>
#import <Foundation/Foundation.h>

typedef void (*DropCallback)(const char *);

@interface SoniqTrayView : NSView <NSDraggingDestination>
@property(nonatomic, assign) DropCallback callback;
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

- (NSView *)hitTest:(NSPoint)point {
  NSView *hit = [super hitTest:point];
  if (hit == self) {
    return nil;
  }
  return hit;
}

@end

static NSStatusItem *globalItem = nil;

void setup_mac_tray(DropCallback callback) {
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
      trayView.callback = callback;
      [trayView setAutoresizingMask:NSViewWidthSizable | NSViewHeightSizable];
      [button addSubview:trayView];

      [button.window registerForDraggedTypes:@[ NSPasteboardTypeFileURL ]];
    }
  });
}
