#include<iostream>
#include<cmath>
#include<vector>
using namespace std;
class Complex{public:
   double x,y;
   Complex(double a=0,double b=0):x(a),y(b){}
   Complex operator+(Complex& p){return Complex(x+p.x,y+p.y);}
   Complex operator*(Complex& p){return Complex(x*p.x-y*p.y,y*p.x+x*p.y);}
   Complex operator /(double b){return Complex(x/b,y/b);}
};
istream &operator>>(istream &is,Complex &c){
                 char c1,c2;
                                        is>>c.x>>c1>>c.y>>c2;
                 if(c1=='-')c.y*=-1;
        return is;
}
ostream& operator<<(ostream& os,const Complex& c){
        if(c.y==0)os<<c.x;
                 else if(c.x==0)os<<c.y<<"i";
                 else if(c.y<0) os<<c.x<<c.y<<"i";
        else os<<c.x<<"+"<<c.y<<"i";
   return os;
}
class CVec{
public:
   vector<Complex> cv;
   Complex tol(){
      Complex ans=cv[0];
      for(int i=1;i<cv.size();i++){
         ans=ans+cv[i];
      }
      return ans;
   }
   Complex cross(){
      Complex ans=cv[0];
      for(int i=1;i<cv.size();i++){
         ans=ans*cv[i];
      }
      return ans;
   }
   Complex avg(){
      return tol()/cv.size();
   }
};
istream& operator>>(istream &is,CVec &a){
     int n;
     is>>n;
     for(int i=0;i<n;i++){
        Complex c;
        is>>c;
        a.cv.push_back(c);
     }
     return is;
}

int main(){
   CVec c;cin>>c;
   cout<<"sum:"<<c.tol()<<endl;  //@ @guide uml:c
   cout<<"Cross product:"<<c.cross()<<endl;
   cout<<"avg:"<<c.avg()<<endl;
   return 0;
}
