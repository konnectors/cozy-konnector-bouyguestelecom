[Cozy][cozy] Bouygues Telecom Konnector
=======================================

What's Cozy?
------------

![Cozy Logo](https://cdn.rawgit.com/cozy/cozy-guidelines/master/templates/cozy_logo_small.svg)

[Cozy] is a platform that brings all your web services in the same private space.  With it, your webapps and your devices can share data easily, providing you with a new experience. You can install Cozy on your own hardware where no one's tracking you.


What's Bouygues Telecom Konnector?
----------------------------------

A connector to retrieve your Bouygues Telecom bills and billing data and save them into your Cozy.

### Open a Pull-Request

If you want to work on this konnector and submit code modifications, feel free to open pull-requests! See the [contributing guide][contribute] for more information about how to properly open pull-requests.

### Run

If you have a running accessible cozy-stack you can test your the konnector without installing
and/or updating the konnector in the cozy-stack :

You first need an installed nodejs (LTS version is fine)

Then just run :

```sh
npm install
npm start
```

### Hack

If you do not want to need to have an accessible cozy-stack, just run :

```sh
npm install
npm run dev
```

The requests to the cozy stack will be stubbed using the ./data/fixture.json file as source of data
and when cozy-client-js is asked to create or update data, the data will be output to the console

This command will register your konnector as an Oauth application to the cozy-stack. By default,
the cozy-stack is supposed to be located in http://cozy.local:8080. If this is not your case, just
update the COZY_URL field in ./data/env.js.
Where 'login' is you phone number for Bouygues Telecom and 'folderPath' is the path where the pdf
bills will be saved

After that, your konnector is run but should not work since you did not specify an credentials to
the target service. You can also do this in ./data/env.js by modifying the COZY_FIELDS attribute
which is a JSON string.

Now run npm run dev one more time, you dont have to do the Oauth thing now, and it should be ok


### Maintainer

The lead maintainers for Bouygues Telecom Konnector is @doubleface for Cozy Cloud


### Get in touch

You can reach the Cozy Community by:

- Chatting with us on IRC [#cozycloud on Freenode][freenode]
- Posting on our [Forum]
- Posting issues on the [Github repos][github]
- Say Hi! on [Twitter]


License
-------

Bouygues Telecom Konnector is developed by @doubleface and distributed under the [AGPL v3 license][agpl-3.0].

[cozy]: https://cozy.io "Cozy Cloud"
[agpl-3.0]: https://www.gnu.org/licenses/agpl-3.0.html
[freenode]: http://webchat.freenode.net/?randomnick=1&channels=%23cozycloud&uio=d4
[forum]: https://forum.cozy.io/
[github]: https://github.com/cozy/
[twitter]: https://twitter.com/mycozycloud
