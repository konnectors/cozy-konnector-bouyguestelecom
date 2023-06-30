import { ContentScript } from 'cozy-clisk/dist/contentscript'
import Minilog from '@cozy/minilog'
const log = Minilog('ContentScript')
Minilog.enable('bouyguestelecomCCC')

const baseUrl = 'https://bouyguestelecom.fr'
const dashboardUrl = 'https://www.bouyguestelecom.fr/mon-compte/dashboard'
class BouyguesTelecomContentScript extends ContentScript {
  async navigateToLoginForm() {
    this.log('info', 'navigateToLoginForm')
    await this.goto(baseUrl)
    await this.waitForElementInWorker('#login')
    await this.waitForElementInWorker('#menu')
    await this.clickAndWait('#login', '#bytelid_partial_acoMenu_login')
  }

  async ensureAuthenticated(account) {
    this.log('info', 'EnsureAuthenticated starts')
    // if (!account) {
    //   await this.ensureNotAuthenticated()
    // }
    await this.navigateToLoginForm()
    if (await this.runInWorker('checkAuthenticated')) {
      this.log('info', 'Auth detected')
      return true
    }
    this.log('info', 'No auth detected')
    // let credentials = await this.getCredentials()
    // if (credentials && credentials.email && credentials.password) {
    //   try {
    //     this.log('info', 'Got credentials, trying autologin')
    //     await this.tryAutoLogin(credentials)
    //   } catch (error) {
    //     this.log('warn', 'autoLogin error' + error.message)
    //     await this.showLoginFormAndWaitForAuthentication()
    //   }
    // } else {
    //   this.log('info', 'No credentials found, waiting for user input')
    //   await this.showLoginFormAndWaitForAuthentication()
    // }
    this.log('info', 'No credentials found, waiting for user input')
    await this.showLoginFormAndWaitForAuthentication()
    return true
  }

  async ensureNotAuthenticated() {
    await this.navigateToLoginForm()
    const authenticated = await this.runInWorker('checkAuthenticated')
    if (!authenticated) {
      return true
    }
  }

  async checkAuthenticated() {
    const passwordField = document.querySelector('#password')
    const loginField = document.querySelector('#username')
    if (passwordField && loginField) {
      const userCredentials = await this.findAndSendCredentials.bind(this)(
        loginField,
        passwordField
      )
      this.log('info', "Sending user's credentials to Pilot")
      this.sendToPilot({
        userCredentials
      })
    }
    if (
      document.location.href === dashboardUrl &&
      document.querySelector('#notifications')
    ) {
      this.log('info', 'Auth check succeeded')
      return true
    }
    return false
  }

  async findAndSendCredentials(loginField, passwordField) {
    this.log('info', 'findAndSendCredentials starts')
    let userLogin = loginField.value
    let userPassword = passwordField.value
    const userCredentials = {
      email: userLogin,
      password: userPassword
    }
    return userCredentials
  }

  async showLoginFormAndWaitForAuthentication() {
    this.log('info', 'showLoginFormAndWaitForAuthentication start')
    await this.setWorkerState({ visible: true })
    await this.runInWorkerUntilTrue({
      method: 'waitForAuthenticated'
    })
    await this.setWorkerState({ visible: false })
  }

  async getUserDataFromWebsite() {
    await this.navigateToInfosPage()
    await this.runInWorker('fetchIdentity')
    await this.saveIdentity(this.store.userIdentity)
    return {
      sourceAccountIdentifier: this.store.userIdentity.email
        ? this.store.userIdentity.email
        : 'defaultTemplateSourceAccountIdentifier'
    }
  }

  async fetch(context) {
    this.log('info', 'fetch starts')
    // await this.navigateToBillsPage()
  }

  async navigateToInfosPage() {
    this.log('info', 'navigateToInfosPage starts')
    await this.waitForElementInWorker('div[href="/mon-compte/infosperso"] a')
    await this.clickAndWait(
      'div[href="/mon-compte/infosperso"] a',
      '.personalInfosAccountDetails'
    )
  }

  // async navigateToBillsPage(){
  //   await this.clickAndWait('#menu', '.has-ending-arrow')
  //   await this.clickAndWait('')
  // }

  async fetchIdentity() {
    let mailAddress
    let phoneNumber
    const infosElements = document.querySelectorAll(
      '.personalInfosAccountDetails .tiles .segment:not(.flexCenter)'
    )
    const elementsArray = Array.from(infosElements)
    elementsArray.shift()
    const infosArray = []
    for (const info of elementsArray) {
      const spans = info.querySelectorAll('span')
      // Here we select index 1 because index 0 is the section's name
      const spanInfo = spans[1].textContent
      infosArray.push(spanInfo)
    }
    mailAddress = infosArray[0]
    phoneNumber = infosArray[1].replace(/ /g, '')
    const firstName = document.querySelector('.firstName').textContent
    const familyName = document.querySelector('.name').textContent
    const addressElement = document.querySelector(
      '.personalInfosBillingAddress .ui .is360 .text div[class="ui is360 text"] > span'
    ).innerHTML
    const [street, postCodeAndCity, country] = addressElement.split('<br>')
    const [postCode, city] = postCodeAndCity.split(' ')
    const userIdentity = {
      email: mailAddress,
      phone: [
        {
          type: phoneNumber.startsWith('06' || '07') ? 'mobile' : 'home',
          number: phoneNumber
        }
      ],
      name: {
        givenName: firstName,
        familyName
      },
      address: {
        street,
        postCode,
        city,
        country,
        formattedAddress: addressElement.replace(/<br>/g, ' ')
      }
    }
    await this.sendToPilot({ userIdentity })
    this.log('info', `${JSON.stringify(userIdentity)}`)
  }
}

const connector = new BouyguesTelecomContentScript()
connector
  .init({ additionalExposedMethodsNames: ['fetchIdentity'] })
  .catch(err => {
    log.warn(err)
  })
