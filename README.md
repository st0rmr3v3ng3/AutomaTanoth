# AutomaTanoth 0.92
This script is designed to automate the Tanoth game while offering better modularity and usability compared to the original.
Compared to the original script, this version is ~cleaner~ *i wish*, more configurable, and now runs as a Tampermonkey userscript with an in-game UI.
Initial goals: 

- ✅convert the script to a Greasemonkey/Tampermonkey userscript
- ✅create a simple DOM UI to control the bot
- ✅rewrite functions and methods as microservices
- 🚧fix attempt spam when bot is started while an adventure is ongoing
- ❌~add memory functions for data collection/performance analysis to enable 1. persistence of settings 2. possibility for ML/optimization~ *not happening.*




## Bot Features
- Automatically completes adventures
- Manages gold spending based on configuration
- Supports different difficulty and priorities of adventures
- now with a UI allowing for starting/stopping the bot and on-the-fly config adjustment

## How to Install & Use

### 1. Install a Userscript Manager

You’ll need a browser extension that can run userscripts. Either of these works:

- [Tampermonkey](https://chromewebstore.google.com/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo)
- [Violentmonkey](https://violentmonkey.github.io/)

Install one of them and make sure it’s enabled.

### 2. Create a New Userscript

Click the extension icon (Tampermonkey or Violentmonkey) in your browser toolbar

Select “Create a new script”

Remove the default template code

Paste the contents of main.js into the script editor

### 3. Save & Enable the Script

Save the script

Verify it is enabled in the extension’s dashboard/list

### 4. Open the Game
  
Go to [Tanoth](https://lobby.tanoth.gameforge.com)

Log in to your account and select your server

### 5. Run the Bot

Once the page loads, the AutomaTanoth UI should appear automatically

Click Run to start the bot

Adjust configuration live through the UI as needed

### 6. Stop the Bot

Use the Stop button in the UI

## Notes
- The bot runs until the adventures are finished. ~It is possible to use bloodstones if you put the attribute "useBloodstones" to true.~ *it is NOT possible right now. BS code is removed, re-adding is low prio.*
- It will spend gold on improving attributes *fixed in 0.92* or the circle based on configuration.
- Since the bot executes tasks in the background, sometimes the game may not synchronize correctly.
- I am not responsible for any bans resulting from the use of this bot.
- I will probably re-write the entire thing as a headless desktop python version cause userscripts get really convoluted really fast.

Enjoy playing  with automation! 🚀


## Disclaimer
All bugs are features, you are free to contact me but any requests are likely to end up buried between the ridiculous amounts of spam mail in my inbox. 


