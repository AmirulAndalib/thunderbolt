# Mobile UI

Background:
- When I'm on the home screen, the app is scrolling a little bit up and down on mobile.

To Do (these only apply to mobile - be sure not to break desktop):
- When the keyboard is visible, hide the suggested prompt buttons and bottom-align the text input so that they software keyboard is immediately below it. This is likely the same as when the keyboard is bottom-aligned after the user has submitted text. Ensure that this works flawlessly on all device sizes.
- Add an invisible header on mobile (for the purpose of holding and aligning icons and such) with a hamburger menu button version of the sidebar trigger on desktop.

# Sidebar Component
- Instead of a sidebar like we have on desktop, we want essentially a full-screen menu to appear with the same content as the sidebar. Here are the qualities we want it to have:
    - Ideally it should animate in from the left side like a real mobile app side menu would.
    - It needs to work flawlessly on all devices and screen sizes, whether clicked or touched
    - Ideally can be dragged to be closed
    - Ideally be the same component (even if it uses a higher order component to wrap separate and desktop components)
    - Make it easy to create additional side menus in the app by just using the component with the intended content (eg, the complexity of making this look and feel different on desktop vs mobile should be fully abstracted away into an elegant, easy-to-use component)
    - Should have an "x" button (Lucide icon) in the top right corner to close it on mobile
    - Should retain the current sidebar icon and functionality on desktop

There are a few ways this could be implemented. When you get to this step, your job is to analyze the different options for doing this, provide a thourough explanation of what the pros and cons of each are, and then make a recommendation, then stop and wait for approval. The ideas I currently have are:
    - A full-screen modal from ShadCN
    - A "sheet" component from ShadCN
    - A modifid version of ShadCN's full-screen modal
    - Another library not considered above
    - Something else not considered above