# Savior of Song "Kongou" Configuration Lifecycle Manager for BlueSteel ALLS Images
Configuration Management System for BlueSteel installations

## Important Note!
This is NOT in ANY WAY compatible with a official ALLS/Nu keychip/preboot and is designed to work with a sudo-ALLS setup where sgpreboot does not exist. It is designed to recreate the hardware key requirement to use the game and protect data in transit and from offline ripping. This is not designed to be super high security.


## Build EXE
Run this first<br/>
```powershell
npm install pkg -g
npm install resedit-cli -g
```

```powershell
pkg --compress GZip .
npx resedit --in .\build\sos-kongou-lcc.exe --out .\build\savior_of_song_lifecycle.exe --icon 1,icon.ico --no-grow --company-name "Academy City Research P.S.R." --file-description "KONGOU Lifecycle Controller" --product-version 1.1.0.0 --product-name 'Savior Of Song Lifecycle Controller "KONGOU"'
pkg  --target node16-win-x64 --compress GZip .\bootstrap.js --output .\build\sos-kongou-bootstrap.exe
npx resedit --in .\build\sos-kongou-bootstrap.exe --out .\build\savior_of_song_bootstrap.exe --icon 1,icon2.ico --no-grow --company-name "Academy City Research P.S.R." --file-description "KONGOU Bootstrap" --product-version 1.1.0.0 --product-name 'Savior Of Song Bootstrap "KONGOU"'
```
