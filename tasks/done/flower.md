# Flower AI - Full Integration

Background:

- Currently, we have a Flower AI screen that is separate from the main chat screen. It uses its own logic and components.

Goals:

- The user should never see anything about "Flower AI" - instead, they will see "Confidential Compute" or similar. Flower will simply serve as the UI library and inference provider for these confidential chats.
- The main chat screen should handle Flower AI chats as well as continuing to handle "normal" chats with existing providers like OpenAI Compatible, Fireworks, and Thunderbolt.
- All Confidential AI chats should be encrypted - there should not even be an option for this, it should simply be how they work.
- For now, we will not have any special visual components describing the encryption or security of Confidential chats.
- Confidential models will be selected in the dropdown alongside other models.
  - We could either (a) create a separate provider like "Thunderbolt (Confidential)" or (b) have "Confidential" be a property of model configurations. We want to go with whichever option results in the cleanest, most efficient, organized code and architecture.
- We should have "mistralai/mistral-small-3.1-24b" be the singular Confidential model that is added to the seed data and available in the dropdown.
- In chat sidebar list of chat threads, we should see a lock icon on the left side of the thread title (where the current flower emoji is) which will be a Lucide icon.
- We want Confidential chats to use as much of the existing code and share as much code as possible with existing chats. However, it is clear that there will be major differences, so it is ok to have separate code where it makes sense in order to keep the logic clean, concise, modulear, and maintainable. We want to avoid a lot of if statements and prefer separate functions, components, or classes if it helps keep the code organized. We want the code to be very testable.
